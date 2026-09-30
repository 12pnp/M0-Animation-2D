/** A message from an export: an error refuses the export, a warning ships it. */
export interface ExportDiagnostic {
  severity: "error" | "warning";
  message: string;
}
