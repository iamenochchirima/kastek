import type { Pool } from "pg";
import { query } from "../pool";

export interface KasiAiPreferenceRecord {
  organization_id: string;
  installation_id: string;
  owner_actor_id: string;
  language: string | null;
  tone: "concise" | "balanced" | "detailed" | null;
  response_detail: "concise" | "standard" | "detailed" | null;
  notifications_enabled: boolean;
  use_saved_preferences: boolean;
  reference_previous_chats: boolean;
  default_model_provider: string | null;
  default_model: string | null;
  default_credential_reference: string | null;
  created_at: string;
  updated_at: string;
}

export class KasiAiPreferenceRepository {
  public constructor(private readonly pool: Pool) {}

  public async get(organizationId: string, installationId: string, ownerActorId: string): Promise<KasiAiPreferenceRecord | null> {
    const result = await query<KasiAiPreferenceRecord>(
      this.pool,
      `SELECT * FROM kasiai_user_preferences
       WHERE organization_id = $1 AND installation_id = $2 AND owner_actor_id = $3`,
      [organizationId, installationId, ownerActorId],
    );
    return result.rows[0] ?? null;
  }

  public async upsert(
    organizationId: string,
    installationId: string,
    ownerActorId: string,
    input: Partial<Omit<KasiAiPreferenceRecord, "organization_id" | "installation_id" | "owner_actor_id" | "created_at" | "updated_at">>,
  ): Promise<KasiAiPreferenceRecord> {
    const result = await query<KasiAiPreferenceRecord>(
      this.pool,
      `INSERT INTO kasiai_user_preferences
        (organization_id, installation_id, owner_actor_id, language, tone, response_detail,
         notifications_enabled, use_saved_preferences, reference_previous_chats,
         default_model_provider, default_model, default_credential_reference)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE), COALESCE($8, TRUE), COALESCE($9, FALSE), $10, $11, $12)
       ON CONFLICT (organization_id, installation_id, owner_actor_id) DO UPDATE SET
         language = COALESCE(EXCLUDED.language, kasiai_user_preferences.language),
         tone = COALESCE(EXCLUDED.tone, kasiai_user_preferences.tone),
         response_detail = COALESCE(EXCLUDED.response_detail, kasiai_user_preferences.response_detail),
         notifications_enabled = COALESCE($7, kasiai_user_preferences.notifications_enabled),
         use_saved_preferences = COALESCE($8, kasiai_user_preferences.use_saved_preferences),
         reference_previous_chats = COALESCE($9, kasiai_user_preferences.reference_previous_chats),
         default_model_provider = COALESCE(EXCLUDED.default_model_provider, kasiai_user_preferences.default_model_provider),
         default_model = COALESCE(EXCLUDED.default_model, kasiai_user_preferences.default_model),
         default_credential_reference = CASE WHEN $13::boolean THEN EXCLUDED.default_credential_reference ELSE kasiai_user_preferences.default_credential_reference END,
         updated_at = now()
       RETURNING *`,
      [
        organizationId, installationId, ownerActorId,
        input.language ?? null, input.tone ?? null, input.response_detail ?? null,
        input.notifications_enabled ?? null, input.use_saved_preferences ?? null,
        input.reference_previous_chats ?? null, input.default_model_provider ?? null, input.default_model ?? null,
        input.default_credential_reference ?? null, input.default_credential_reference !== undefined,
      ],
    );
    return result.rows[0]!;
  }
}
