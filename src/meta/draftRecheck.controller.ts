import { Request, Response } from "express";
import { CreateDBConnection } from "../../db/create-connection";
import { returnedRows } from "../../utils/dbResult";

// POST /api/marketplace/admin/pieces/:id/recheck  { reason?: string }
//
// Re-runs Muse's draft check on a piece already with the brand (3-Nov-2026).
// Piece 799 was checked under the old 150 MB cap, stored `unsupported`, and
// nothing ever re-runs a check, so raising the cap did not help it.
//
// This does NOT run the check itself (that takes minutes and needs the worker).
// It returns the piece to the worker's draft_submitted lane (claimIn): that
// lane picks any piece whose ai_check_version differs from its version. The
// state goes to `queued`, so the chat card reads "Checking…" until the result
// lands. Nothing is sent to anyone: finish() only notifies while a piece is
// still `checking`, and a draft_submitted piece is not.
//
// Provenance (DONE rule 3): ai_check_result.recheck = { by, at, reason },
// which finish() keeps because it merges results. The lane only picks drafts
// sent in the last 3 days, so this refuses older ones instead of queueing
// something that would never run.
export const adminRecheckDraft = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: "Bad piece id." });
    const reason = String(req.body?.reason ?? "").trim().slice(0, 300) || "admin re-run";
    const rows = returnedRows<{ id: number; version: number }>(await CreateDBConnection.query(
      `UPDATE application_deliverable
          SET ai_check_version = NULL, ai_check_status = 'queued', ai_check_error = NULL,
              ai_check_attempts = 0, ai_check_started_at = NULL, ai_check_finished_at = NULL,
              ai_check_result = COALESCE(ai_check_result, '{}'::jsonb)
                || jsonb_build_object('recheck', jsonb_build_object('by', $2::int, 'at', NOW(), 'reason', $3::text))
        WHERE id = $1::int
          AND draft_status = 'draft_submitted'
          AND draft_submitted_at > NOW() - INTERVAL '3 days'
          AND COALESCE(draft_file, draft_url) IS NOT NULL
          AND COALESCE(ai_check_status, '') <> 'running'
        RETURNING id, version`,
      [id, Number(req.authId), reason],
    ));
    if (!rows.length) {
      return res.status(409).json({
        success: false,
        message: "Can't re-run: the piece must be a draft with the brand, sent in the last 3 days, with a file or link, and not being checked right now.",
      });
    }
    return res.json({ success: true, message: "Queued. The worker re-runs the check within a minute or two.", data: rows[0] });
  } catch (e: any) {
    return res.status(500).json({ success: false, message: "Couldn't queue the re-check." });
  }
};
