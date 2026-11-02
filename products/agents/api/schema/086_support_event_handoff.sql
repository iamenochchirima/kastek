-- A waiting episode can originate from an agent task or a customer message.
-- Keep the original episode key so existing notices and workflow identities remain valid.
ALTER TABLE agents_platform.support_waiting DROP CONSTRAINT support_waiting_task_id_fkey;
ALTER TABLE agents_platform.support_waiting ADD COLUMN source_task_id uuid REFERENCES agents_platform.tasks(id);
ALTER TABLE agents_platform.support_waiting ADD COLUMN source_message_id uuid REFERENCES agents_platform.customer_messages(id);
UPDATE agents_platform.support_waiting SET source_task_id=task_id;
ALTER TABLE agents_platform.support_waiting ADD CONSTRAINT support_waiting_source_check CHECK (
  (source_task_id IS NOT NULL AND source_task_id=task_id AND source_message_id IS NULL) OR
  (source_task_id IS NULL AND source_message_id IS NOT NULL AND source_message_id=task_id)
);
