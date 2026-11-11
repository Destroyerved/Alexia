//! High-throughput async EventBus with `redb` persistence and `tokio::sync::broadcast` SSE fanout.

use crate::core::db::AlexiaDb;
use crate::core::schemas::{Event, Incident};
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, Notify};

pub type EventHandler =
    Arc<dyn Fn(Event) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub struct EventBus {
    db: Arc<AlexiaDb>,
    sse_tx: broadcast::Sender<Value>,
    subscribers: RwLock<Vec<(String, EventHandler)>>,
    in_flight: AtomicUsize,
    drained: Notify,
}

impl EventBus {
    pub fn new(db: Arc<AlexiaDb>) -> Arc<Self> {
        let (sse_tx, _) = broadcast::channel(512);
        Arc::new(Self {
            db,
            sse_tx,
            subscribers: RwLock::new(Vec::new()),
            in_flight: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }

    pub fn subscribe_sse(&self) -> broadcast::Receiver<Value> {
        self.sse_tx.subscribe()
    }

    pub fn broadcast_sse(&self, payload: Value) {
        let _ = self.sse_tx.send(payload);
    }

    pub fn subscribe<F, Fut>(&self, pattern: &str, handler: F)
    where
        F: Fn(Event) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let wrapped: EventHandler = Arc::new(move |evt| Box::pin(handler(evt)));
        self.subscribers.write().push((pattern.to_string(), wrapped));
    }

    /// Persists the event, broadcasts over SSE, and spawns matching async handlers without blocking the caller.
    pub fn publish(self: &Arc<Self>, event: Event) {
        let _ = self.db.persist_event(&event);
        self.broadcast_sse(json!({
            "type": "event",
            "data": event,
        }));

        let handlers: Vec<EventHandler> = {
            let subs = self.subscribers.read();
            subs.iter()
                .filter(|(pat, _)| pat == "*" || pat == &event.kind || pat == &event.source)
                .map(|(_, cb)| cb.clone())
                .collect()
        };

        if handlers.is_empty() {
            return;
        }

        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let bus_clone = self.clone();
        tokio::spawn(async move {
            for h in handlers {
                h(event.clone()).await;
            }
            if bus_clone.in_flight.fetch_sub(1, Ordering::SeqCst) == 1 {
                bus_clone.drained.notify_waiters();
            }
        });
    }

    pub fn is_busy(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst) > 0
    }

    pub async fn drain(&self) {
        while self.in_flight.load(Ordering::SeqCst) > 0 {
            self.drained.notified().await;
        }
    }

    pub fn create_incident(&self, mut inc: Incident) -> Incident {
        let _ = self.db.upsert_incident(&mut inc);
        self.broadcast_sse(json!({
            "type": "incident_created",
            "data": inc,
        }));
        inc
    }

    pub fn update_incident(&self, inc: &mut Incident, _reason: &str) {
        let _ = self.db.upsert_incident(inc);
        self.broadcast_sse(json!({
            "type": "incident_updated",
            "data": inc,
        }));
    }

    pub fn get_incident(&self, id: &str) -> Option<Incident> {
        self.db.get_incident(id)
    }

    pub fn list_incidents(&self, status: Option<&str>, limit: usize) -> Vec<Incident> {
        self.db.list_incidents(status, limit)
    }
}
