/**
 * Maps the controller's pending decisions (a reviewed change proposal and approval requests bound to canonical
 * plans) to the permission requests the vendored frontend renders. The frontend never decides an effect: a reply is
 * forwarded to the same controller/approval actions the previous interface used, which still require the verified
 * plan, the native consent signature and the recorded receipt.
 */
import { createTwoFilesPatch } from "diff"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type { ChangeProposal } from "../../../change-proposal.ts"
import type { BoundApprovalRequest } from "../../../approvals.ts"

export interface ChangeFileView {
  path: string
  added: number
  removed: number
  created: boolean
  selected: boolean
  diff: string
  hunks: Array<{ index: number; selected: boolean; header: string }>
}

export function changeFiles(proposal: ChangeProposal): ChangeFileView[] {
  return proposal.files.map((file) => ({
    path: file.path,
    added: file.added,
    removed: file.removed,
    created: file.before === null,
    selected: file.selected,
    diff: createTwoFilesPatch(file.path, file.path, file.before ?? "", file.after, "", "", { context: 3 }),
    hunks: file.hunks.map((hunk, index) => ({
      index,
      selected: file.selectedHunks === null ? file.selected : file.selectedHunks.has(index),
      header: `@@ -${(hunk as { oldStart?: number }).oldStart ?? "?"} +${(hunk as { newStart?: number }).newStart ?? "?"} @@`,
    })),
  }))
}

export function proposalRequest(proposal: ChangeProposal, sessionID: string): PermissionRequest {
  const files = changeFiles(proposal)
  return {
    id: proposal.id,
    sessionID,
    permission: "uptokey_change",
    patterns: files.map((file) => file.path),
    always: [],
    metadata: {
      uptokey: true,
      state: proposal.state,
      files,
      failures: proposal.failures.length,
      rejectedBlocks: proposal.rejectedBlocks.length,
      message: proposal.message ?? "",
      filepath: files[0]?.path ?? "",
    },
  }
}

export function approvalRequest(approval: BoundApprovalRequest, sessionID: string): PermissionRequest {
  return {
    id: approval.id,
    sessionID,
    permission: "uptokey_approval",
    patterns: approval.path ? [approval.path] : [],
    always: [],
    metadata: {
      uptokey: true,
      type: approval.type,
      description: approval.description,
      detail: approval.detail ?? "",
      risk: approval.risk,
      riskBadge: approval.riskBadge ?? "",
      riskSummary: approval.riskSummary ?? "",
      tool: approval.tool ?? "",
      args: approval.args ?? "",
      path: approval.path ?? "",
      diff: approval.diff ?? "",
      hasPlan: Boolean(approval.planId),
    },
  }
}

export function confirmRequest(review: { id: string; title: string; body: string }, sessionID: string): PermissionRequest {
  return {
    id: review.id,
    sessionID,
    permission: "uptokey_confirm",
    patterns: [],
    always: [],
    metadata: { uptokey: true, title: review.title, body: review.body },
  }
}

/** Tracks which decisions the frontend has been told about, so each is announced and settled exactly once. */
export class PermissionMirror {
  private announced = new Map<string, string>()

  reset() {
    this.announced.clear()
  }

  /** Returns the events to emit for the current set of pending decisions. */
  diff(sessionID: string, proposal: ChangeProposal | null, approvals: readonly BoundApprovalRequest[], confirmation: { id: string; title: string; body: string } | null = null) {
    const current = new Map<string, { key: string; request: PermissionRequest }>()
    if (proposal && proposal.state === "proposed") {
      const request = proposalRequest(proposal, sessionID)
      current.set(proposal.id, { key: JSON.stringify([proposal.state, request.metadata.files, request.metadata.failures]), request })
    }
    if (confirmation) {
      const request = confirmRequest(confirmation, sessionID);
      current.set(confirmation.id, { key: JSON.stringify(request.metadata), request });
    }
    for (const approval of approvals) {
      const request = approvalRequest(approval, sessionID)
      current.set(approval.id, { key: JSON.stringify(request.metadata), request })
    }
    const events: Array<{ type: string; properties: Record<string, unknown> }> = []
    for (const [id] of this.announced) {
      if (current.has(id)) continue
      this.announced.delete(id)
      events.push({ type: "permission.replied", properties: { sessionID, requestID: id, reply: "once" } })
    }
    for (const [id, entry] of current) {
      if (this.announced.get(id) === entry.key) continue
      this.announced.set(id, entry.key)
      events.push({ type: "permission.asked", properties: entry.request as unknown as Record<string, unknown> })
    }
    return events
  }
}
