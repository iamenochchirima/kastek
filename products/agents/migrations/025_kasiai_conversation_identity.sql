UPDATE conversations c
SET channel_type = 'unified',
    channel_key = 'kasiai',
    updated_at = now()
FROM agent_installations installation
JOIN agent_definitions definition
  ON definition.id = installation.agent_definition_id
WHERE c.installation_id = installation.id
  AND definition.slug = 'kasiai'
  AND c.channel_type = 'platform'
  AND c.channel_key = 'sidebar';
