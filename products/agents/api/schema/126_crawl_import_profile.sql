-- An accepted crawl selection keeps its processing profile across retries and runtime changes.
ALTER TABLE agents_platform.website_crawls ADD COLUMN import_profile_release text;
