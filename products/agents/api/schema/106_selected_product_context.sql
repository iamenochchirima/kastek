-- Only a context explicitly selected by the user is made available to a new task.
-- Existing tasks retain NULL; an implicit workspace is not an attachment.
ALTER TABLE agents_platform.product_task_contexts ADD COLUMN selected_context jsonb;
