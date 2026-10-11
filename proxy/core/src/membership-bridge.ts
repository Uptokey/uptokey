import type { MembershipView } from "./delegated-access.ts";

/** Adapts control-plane team roster seats into MembershipView without owning TeamMembershipService. */
export function membershipViewFromSeat(input: {
  seatId: string;
  tenantId: string;
  principalId: string;
  status: "active" | "pending" | "revoked" | "expired" | string;
  role: "owner" | "admin" | "member";
}): MembershipView {
  return {
    membershipId: input.seatId,
    tenantId: input.tenantId,
    principalId: input.principalId,
    active: input.status === "active",
    role: input.role,
  };
}

/** Synthetic invite/accept fixture for local proofs — never sends email. */
export function syntheticTeamIdentities(tenantId: string): {
  owner: MembershipView;
  memberA: MembershipView;
  memberB: MembershipView;
} {
  return {
    owner: { membershipId: "seat_owner", tenantId, principalId: "principal_owner", active: true, role: "owner" },
    memberA: { membershipId: "seat_a", tenantId, principalId: "principal_a", active: true, role: "member" },
    memberB: { membershipId: "seat_b", tenantId, principalId: "principal_b", active: true, role: "member" },
  };
}
