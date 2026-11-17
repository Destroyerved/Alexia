; Uninstalling the Alexia Server Manager leaves C:\Alexia (the running platform, the SQLite
; database, audit ledger, and backups) untouched. It only removes the manager's own sign-in task.
!macro customUnInstall
  nsExec::ExecToLog 'schtasks /delete /tn "Alexia Manager" /f'
!macroend
