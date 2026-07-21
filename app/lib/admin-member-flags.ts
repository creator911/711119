export type AdminMemberFlags = {
  isDirector: unknown;
  isPartner: unknown;
};

export function normalizeAdminMemberFlags<T extends AdminMemberFlags>(member: T): Omit<T, keyof AdminMemberFlags> & { isDirector: boolean; isPartner: boolean } {
  return {
    ...member,
    isDirector: Boolean(member.isDirector),
    isPartner: Boolean(member.isPartner),
  };
}
