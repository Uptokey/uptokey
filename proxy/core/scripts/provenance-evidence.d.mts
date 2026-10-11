export interface ProvenanceSubject { name: string; sha256: string }
export interface ProvenanceReceipt {
  schema: string;
  verifiedAt: string;
  repository: string;
  signerWorkflow: string;
  sourceCommit: string;
  toolchain: string[];
  subjects: ProvenanceSubject[];
  transparencyLog: Array<{ type: "Tlog"; timestamp: string }>;
  checks: { sigstoreBundle: boolean; githubOidcIdentity: boolean; inTotoSubjects: boolean; slsaBuildDefinition: boolean; transparencyLog: boolean };
}

export function createProvenanceReceipt(
  artifact: string,
  bundle: string,
  repository: string,
  signerWorkflow: string,
  sourceCommit: string,
  run?: (args: string[]) => string,
): ProvenanceReceipt;
export function provenanceFromGhVerification(output: string, repository: string): { subjects: ProvenanceSubject[]; sourceCommit: string; transparencyLog: Array<{ type: "Tlog"; timestamp: string }> };
export function validateProvenanceReceipt(receipt: unknown, expectedDigests: string[], expectedCommit: string, expectedRepository: string, expectedSignerWorkflow: string): string[];
