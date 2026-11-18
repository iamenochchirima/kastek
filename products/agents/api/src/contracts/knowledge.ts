export interface KnowledgeSnippet {
  evidenceId: string;
  label: string;
  citation: string;
  sourceId: string | null;
  revisionId: string | null;
  title: string;
  page: number | null;
  acquiredAt: string;
  start: number;
  end: number;
  text: string;
}

export interface KnowledgeObservation {
  profile: "lexical-v1" | "hybrid-v1";
  passages: KnowledgeSnippet[];
  omitted: number;
}

/** Retrieval surface execution depends on. The platform knowledge runtime implements it. */
export interface KnowledgeRuntimePort {
  pinnedEligible(taskId: string, maxSections?: number, maxChars?: number): Promise<boolean>;
  pinnedSources(taskId: string, budgetChars?: number): Promise<Array<{ id: string; revisionId: string; sourceId: string;
    title: string; headingPath: string; content: string }>>;
  search(taskId: string, operationId: string, query: string): Promise<KnowledgeObservation>;
  read(taskId: string, operationId: string, evidenceId: string, offset?: number): Promise<unknown>;
}
