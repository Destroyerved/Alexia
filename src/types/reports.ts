export type ReportType =
  | 'cert_in'
  | 'dpdp_intimation'
  | 'dpdp_detailed'
  | 'gdpr_draft';

export interface SecurityReport {
  id: string;
  incident_id: string;
  report_type: ReportType;
  title: string;
  created_at: string;
  updated_at: string;
  status: 'draft' | 'under_review' | 'ready_for_export';
  sections: Array<{
    heading: string;
    content: string;
  }>;
  disclaimer: string;
  exported_count: number;
}
