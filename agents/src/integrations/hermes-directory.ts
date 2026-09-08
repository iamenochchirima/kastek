export const HERMES_CATALOG_REVISION = "9a84bee265daad14340a80d7585928cd8ea1f9eb";

export type HermesMcpAuth = "oauth" | "api_key" | "none";
export type HermesMcpTransport = "http" | "stdio";

export interface HermesMcpCatalogEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  sourceUrl: string;
  endpointUrl: string | null;
  transport: HermesMcpTransport;
  auth: HermesMcpAuth;
  keywords: string[];
  hosts: string[];
  defaultExcludedTools: string[];
  defaultEnabledTools: string[];
  managed: boolean;
}

export interface HermesSkillCatalogEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  category: string;
  tags: string[];
  sourceUrl: string;
  rawUrl: string;
}

export const HERMES_MCP_CATALOG = [
  {
    "id": "hermes.mcp.airtable",
    "slug": "airtable",
    "name": "airtable",
    "description": "Bases, tables, and records from your Airtable workspace.",
    "sourceUrl": "https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server",
    "endpointUrl": "https://mcp.airtable.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "airtable"
    ],
    "hosts": [
      "airtable.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.algolia",
    "slug": "algolia",
    "name": "algolia",
    "description": "Algolia search: indices, analytics, and settings (read-only).",
    "sourceUrl": "https://www.algolia.com/doc/guides/model-context-protocol/productivity-mcp",
    "endpointUrl": "https://mcp.algolia.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "algolia"
    ],
    "hosts": [
      "algolia.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.alltrails",
    "slug": "alltrails",
    "name": "alltrails",
    "description": "AllTrails: find hikes and trails with reviews and ratings.",
    "sourceUrl": "https://www.alltrails.com/mcp",
    "endpointUrl": "https://www.alltrails.com/mcp",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "hiking",
      "trail",
      "alltrails"
    ],
    "hosts": [
      "alltrails.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.amplitude",
    "slug": "amplitude",
    "name": "amplitude",
    "description": "Amplitude analytics: charts, dashboards, experiments, flags.",
    "sourceUrl": "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
    "endpointUrl": "https://mcp.amplitude.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "amplitude"
    ],
    "hosts": [
      "amplitude.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.asana",
    "slug": "asana",
    "name": "asana",
    "description": "Tasks, projects, and goals from your Asana workspace.",
    "sourceUrl": "https://developers.asana.com/docs/using-asanas-mcp-server",
    "endpointUrl": "https://mcp.asana.com/sse",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "asana"
    ],
    "hosts": [
      "asana.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.atlassian",
    "slug": "atlassian",
    "name": "atlassian",
    "description": "Jira issues and Confluence pages via Atlassian's hosted remote MCP.",
    "sourceUrl": "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    "endpointUrl": "https://mcp.atlassian.com/v1/mcp/authv2",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "jira",
      "confluence",
      "atlassian",
      "bitbucket"
    ],
    "hosts": [
      "atlassian.net",
      "atlassian.com",
      "jira.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.attio",
    "slug": "attio",
    "name": "attio",
    "description": "CRM records, lists, and notes in Attio.",
    "sourceUrl": "https://attio.com/help/apps/other-apps/using-the-attio-mcp-server",
    "endpointUrl": "https://mcp.attio.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "attio",
      "crm"
    ],
    "hosts": [
      "attio.com"
    ],
    "defaultExcludedTools": [
      "whoami",
      "query-particle-sql"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.aws-knowledge",
    "slug": "aws-knowledge",
    "name": "aws-knowledge",
    "description": "Authoritative AWS docs, API references, and best practices.",
    "sourceUrl": "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server/",
    "endpointUrl": "https://knowledge-mcp.global.api.aws",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "aws docs",
      "aws knowledge"
    ],
    "hosts": [
      "aws.amazon.com",
      "docs.aws.amazon.com"
    ],
    "defaultExcludedTools": [
      "aws___retrieve_skill"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.betterstack",
    "slug": "betterstack",
    "name": "betterstack",
    "description": "Better Stack: logs, uptime monitors, incidents, and status pages.",
    "sourceUrl": "https://betterstack.com/docs/getting-started/integrations/mcp/",
    "endpointUrl": "https://mcp.betterstack.com",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "better stack",
      "betterstack",
      "uptime monitor"
    ],
    "hosts": [
      "betterstack.com"
    ],
    "defaultExcludedTools": [
      "search_documentation",
      "Search documentation",
      "*instructions*",
      "execute_query",
      "Execute query",
      "create_cloud_connection",
      "Create cloud connection",
      "*team_member*",
      "*team member*"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.buildkite",
    "slug": "buildkite",
    "name": "buildkite",
    "description": "CI/CD pipelines, builds, and test results from Buildkite.",
    "sourceUrl": "https://buildkite.com/docs/apis/mcp-server",
    "endpointUrl": "https://mcp.buildkite.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "buildkite",
      "ci"
    ],
    "hosts": [
      "buildkite.com"
    ],
    "defaultExcludedTools": [
      "access_token",
      "get_job_env"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.calendly",
    "slug": "calendly",
    "name": "calendly",
    "description": "Scheduling links, events, and invitees from Calendly.",
    "sourceUrl": "https://developer.calendly.com/calendly-mcp-server",
    "endpointUrl": "https://mcp.calendly.com",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "calendly",
      "scheduling"
    ],
    "hosts": [
      "calendly.com"
    ],
    "defaultExcludedTools": [
      "list_calendly_skills",
      "load_calendly_skill"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.canva",
    "slug": "canva",
    "name": "canva",
    "description": "Create, search, and manage Canva designs.",
    "sourceUrl": "https://www.canva.dev/docs/mcp/",
    "endpointUrl": "https://mcp.canva.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "canva",
      "design"
    ],
    "hosts": [
      "canva.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.circleci",
    "slug": "circleci",
    "name": "circleci",
    "description": "CircleCI: diagnose build failures, read logs, rerun workflows.",
    "sourceUrl": "https://circleci.com/docs/guides/toolkit/circleci-mcp-overview/",
    "endpointUrl": "https://mcp.circleci.com/v1/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "circleci"
    ],
    "hosts": [
      "circleci.com"
    ],
    "defaultExcludedTools": [
      "hello",
      "download_usage_data"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.clickup",
    "slug": "clickup",
    "name": "clickup",
    "description": "Tasks, docs, and workspaces in ClickUp.",
    "sourceUrl": "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    "endpointUrl": "https://mcp.clickup.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "clickup",
      "task"
    ],
    "hosts": [
      "clickup.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.close",
    "slug": "close",
    "name": "close",
    "description": "Sales CRM: leads, opportunities, calls, and emails.",
    "sourceUrl": "https://help.close.com/docs/mcp-server",
    "endpointUrl": "https://mcp.close.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "close crm"
    ],
    "hosts": [
      "close.com"
    ],
    "defaultExcludedTools": [
      "close_product_knowledge_search",
      "customized_builtin_labels",
      "search",
      "fetch",
      "paginate_search",
      "enrich_field",
      "schedule_voice_agent_call",
      "apply_voice_agent_update",
      "propose_voice_agent_update",
      "find_voice_agents",
      "find_agent_configs",
      "get_voice_agents",
      "get_voice_agent_overview_report",
      "get_voice_agent_performance_report"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.cloudflare",
    "slug": "cloudflare",
    "name": "cloudflare",
    "description": "Full Cloudflare API access via the official remote MCP.",
    "sourceUrl": "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
    "endpointUrl": "https://mcp.cloudflare.com/mcp?codemode=false",
    "transport": "http",
    "auth": "oauth",
    "keywords": [],
    "hosts": [],
    "defaultExcludedTools": [
      "docs",
      "*_radar_*",
      "*_accounts_magic_*",
      "*_accounts_mnm_*",
      "*_accounts_cni_*",
      "*_accounts_teamnet_*",
      "*_accounts_cloudforceone_*",
      "*_accounts_dlp_*",
      "*_accounts_devices*",
      "*_accounts_dex_*",
      "*_accounts_datasecurity_*",
      "*_accounts_emailsecurity_*",
      "*_accounts_scim_*",
      "*_accounts_gateway*",
      "*_accounts_zerotrust_*",
      "*_accounts_one_*",
      "*_accounts_brandprotection_*",
      "*_accounts_intel_*",
      "*_accounts_urlscanner_*",
      "*_accounts_vuln_scanner_*",
      "*_zones_securitycenter_*",
      "*_accounts_securitycenter_*",
      "*_zones_api_gateway_*",
      "*_zones_schema_validation*",
      "*_zones_token_validation*",
      "*_zones_waiting_rooms*",
      "*_accounts_addressing_*",
      "*_accounts_shares*",
      "*_accounts_slurper_*",
      "*_zones_web3_*",
      "*_accounts_flagship_*",
      "*_zones_secondary_dns_*",
      "*_accounts_secondary_dns_*",
      "*_user_load_balancers*"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.cloudinary",
    "slug": "cloudinary",
    "name": "cloudinary",
    "description": "Upload, search, and transform media assets in Cloudinary.",
    "sourceUrl": "https://cloudinary.com/documentation/cloudinary_llm_mcp",
    "endpointUrl": "https://asset-management.mcp.cloudinary.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "cloudinary",
      "media assets"
    ],
    "hosts": [
      "cloudinary.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.comfy-cloud",
    "slug": "comfy-cloud",
    "name": "comfy-cloud",
    "description": "Generate images, video, audio, and 3D on Comfy Cloud.",
    "sourceUrl": "https://docs.comfy.org/agent-tools/cloud",
    "endpointUrl": "https://cloud.comfy.org/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [],
    "hosts": [],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [
      "search_templates",
      "get_template",
      "get_template_schema",
      "search_models",
      "search_nodes",
      "get_node",
      "get_prompting_guide",
      "run_template",
      "submit_workflow",
      "partner_generate",
      "upload_file",
      "apply_slots",
      "get_job_status",
      "wait_for_job",
      "get_output",
      "use_previous_output",
      "cancel_job",
      "get_queue",
      "get_billing_status",
      "get_workflow_canvas_url"
    ],
    "managed": true
  },
  {
    "id": "hermes.mcp.context7",
    "slug": "context7",
    "name": "context7",
    "description": "Up-to-date, version-specific library docs and code examples.",
    "sourceUrl": "https://context7.com/docs/resources/all-clients",
    "endpointUrl": "https://mcp.context7.com/mcp",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "context7",
      "library docs"
    ],
    "hosts": [
      "context7.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.craft",
    "slug": "craft",
    "name": "craft",
    "description": "Craft: structured docs, tasks, and personal knowledge base.",
    "sourceUrl": "https://support.craft.do/hc/en-us/articles/29455875123101",
    "endpointUrl": "https://mcp.craft.do/my/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "craft docs"
    ],
    "hosts": [
      "craft.do"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.datadog",
    "slug": "datadog",
    "name": "datadog",
    "description": "Logs, monitors, dashboards, and incidents from Datadog.",
    "sourceUrl": "https://docs.datadoghq.com/bits_ai/mcp_server/",
    "endpointUrl": "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "datadog",
      "apm"
    ],
    "hosts": [
      "datadoghq.com",
      "datadoghq.eu"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.deepwiki",
    "slug": "deepwiki",
    "name": "deepwiki",
    "description": "Ask questions about any public GitHub repo (Devin's DeepWiki).",
    "sourceUrl": "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    "endpointUrl": "https://mcp.deepwiki.com/mcp",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "deepwiki",
      "repo wiki"
    ],
    "hosts": [
      "deepwiki.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.dropbox",
    "slug": "dropbox",
    "name": "dropbox",
    "description": "Search, read, and manage files in Dropbox.",
    "sourceUrl": "https://help.dropbox.com/integrations/connect-dropbox-mcp-server",
    "endpointUrl": "https://mcp.dropbox.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "dropbox"
    ],
    "hosts": [
      "dropbox.com"
    ],
    "defaultExcludedTools": [
      "GetUsageAndQuota",
      "CreateFileRequest",
      "GetFileRequest",
      "ListFileRequests"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.figma",
    "slug": "figma",
    "name": "figma",
    "description": "Official Figma remote MCP — design context, Code Connect, and write-to-canvas via https://mcp.figma.com/mcp (OAuth).",
    "sourceUrl": "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    "endpointUrl": "https://mcp.figma.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "figma",
      "mockup",
      "wireframe"
    ],
    "hosts": [
      "figma.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.fireflies",
    "slug": "fireflies",
    "name": "fireflies",
    "description": "Meeting transcripts, summaries, and action items.",
    "sourceUrl": "https://docs.fireflies.ai/getting-started/mcp-configuration",
    "endpointUrl": "https://api.fireflies.ai/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "fireflies",
      "meeting notes",
      "transcript"
    ],
    "hosts": [
      "fireflies.ai"
    ],
    "defaultExcludedTools": [
      "fireflies_search",
      "fireflies_fetch"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.gamma",
    "slug": "gamma",
    "name": "gamma",
    "description": "Gamma: generate and edit AI presentations, docs, and sites.",
    "sourceUrl": "https://developers.gamma.app/docs/gamma-mcp-server",
    "endpointUrl": "https://mcp.gamma.app/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "gamma",
      "presentation"
    ],
    "hosts": [
      "gamma.app"
    ],
    "defaultExcludedTools": [
      "get_gamma_viewer_analytics",
      "get_gamma_viewer_detail_analytics",
      "get_gamma_card_analytics"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.gitlab",
    "slug": "gitlab",
    "name": "gitlab",
    "description": "GitLab: issues, merge requests, pipelines, and repo context.",
    "sourceUrl": "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
    "endpointUrl": "https://gitlab.com/api/v4/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "gitlab",
      "merge request"
    ],
    "hosts": [
      "gitlab.com"
    ],
    "defaultExcludedTools": [
      "get_mcp_server_version",
      "list_duo_sessions"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.globalping",
    "slug": "globalping",
    "name": "globalping",
    "description": "Ping, traceroute, DNS, and HTTP tests from global probes.",
    "sourceUrl": "https://github.com/jsdelivr/globalping-mcp-server",
    "endpointUrl": "https://mcp.globalping.dev/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "globalping",
      "traceroute",
      "ping"
    ],
    "hosts": [
      "globalping.io"
    ],
    "defaultExcludedTools": [
      "help",
      "compareLocations",
      "limits"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.grafana",
    "slug": "grafana",
    "name": "grafana",
    "description": "Query metrics, logs, dashboards, alerts, and incidents from Grafana Cloud.",
    "sourceUrl": "https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/",
    "endpointUrl": "https://mcp.grafana.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "grafana",
      "promql",
      "logql",
      "observability",
      "dashboard"
    ],
    "hosts": [
      "grafana.net",
      "grafana.com"
    ],
    "defaultExcludedTools": [
      "ask_assistant",
      "agento11y_*"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.hugging_face",
    "slug": "hugging_face",
    "name": "hugging_face",
    "description": "Models, datasets, Spaces, and papers from the Hugging Face Hub.",
    "sourceUrl": "https://huggingface.co/docs/hub/agents-mcp",
    "endpointUrl": "https://huggingface.co/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "hugging face",
      "huggingface"
    ],
    "hosts": [
      "huggingface.co",
      "hf.co"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.indeed",
    "slug": "indeed",
    "name": "indeed",
    "description": "Search jobs and listings on Indeed.",
    "sourceUrl": "https://docs.indeed.com/indeed-mcp",
    "endpointUrl": "https://mcp.indeed.com/claude/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "indeed",
      "job search"
    ],
    "hosts": [
      "indeed.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.intercom",
    "slug": "intercom",
    "name": "intercom",
    "description": "Conversations, tickets, and customer data from Intercom.",
    "sourceUrl": "https://developers.intercom.com/docs/guides/mcp",
    "endpointUrl": "https://mcp.intercom.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "intercom"
    ],
    "hosts": [
      "intercom.com",
      "intercom.io"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.kiwi",
    "slug": "kiwi",
    "name": "kiwi",
    "description": "Kiwi.com flight search: itineraries with direct booking links.",
    "sourceUrl": "https://www.kiwi.com/stories/kiwi-mcp-connector/",
    "endpointUrl": "https://mcp.kiwi.com",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "flight search",
      "kiwi.com"
    ],
    "hosts": [
      "kiwi.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [
      "search-flight"
    ],
    "managed": true
  },
  {
    "id": "hermes.mcp.klaviyo",
    "slug": "klaviyo",
    "name": "klaviyo",
    "description": "Klaviyo marketing: campaigns, flows, segments, and reporting.",
    "sourceUrl": "https://developers.klaviyo.com/en/docs/klaviyo_mcp_server",
    "endpointUrl": "https://mcp.klaviyo.com/mcp?core-tools-only=true&disable-tools-with-user-generated-content=true",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "klaviyo"
    ],
    "hosts": [
      "klaviyo.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.linear",
    "slug": "linear",
    "name": "linear",
    "description": "Find, create, and update Linear issues, projects, and comments.",
    "sourceUrl": "https://linear.app/docs/mcp",
    "endpointUrl": "https://mcp.linear.app/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "linear"
    ],
    "hosts": [
      "linear.app"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.microsoft-learn",
    "slug": "microsoft-learn",
    "name": "microsoft-learn",
    "description": "Official Microsoft, Azure, and .NET docs and code samples.",
    "sourceUrl": "https://learn.microsoft.com/en-us/training/support/mcp-get-started",
    "endpointUrl": "https://learn.microsoft.com/api/mcp",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "microsoft docs",
      "azure docs",
      "msdn"
    ],
    "hosts": [
      "learn.microsoft.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.miro",
    "slug": "miro",
    "name": "miro",
    "description": "Read and edit Miro boards, diagrams, and frames.",
    "sourceUrl": "https://developers.miro.com/docs/connecting-to-miro-mcp",
    "endpointUrl": "https://mcp.miro.com/",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "miro",
      "whiteboard"
    ],
    "hosts": [
      "miro.com"
    ],
    "defaultExcludedTools": [
      "diagram_create",
      "diagram_get_dsl",
      "layout_create",
      "layout_get_dsl",
      "layout_read",
      "layout_update"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.mixpanel",
    "slug": "mixpanel",
    "name": "mixpanel",
    "description": "Mixpanel analytics: events, funnels, retention, dashboards.",
    "sourceUrl": "https://docs.mixpanel.com/docs/mcp",
    "endpointUrl": "https://mcp.mixpanel.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "mixpanel"
    ],
    "hosts": [
      "mixpanel.com"
    ],
    "defaultExcludedTools": [
      "Get-Experiment-Setup-Guidance",
      "Get-Experiment-Results-Interpretation-Guidance",
      "Explain-Experiment-Health-Check",
      "Run-Experiment-Pre-Launch-Checks",
      "Get-Feature-Flag-Setup-Guidance",
      "Get-Feature-Flag-Lifecycle-Guidance",
      "Display-Query",
      "Get-Lexicon-URL",
      "Bulk-Edit-Events",
      "Bulk-Edit-Properties"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.monday",
    "slug": "monday",
    "name": "monday",
    "description": "Boards, items, docs, and workflows in monday.com.",
    "sourceUrl": "https://developer.monday.com/apps/docs/mondaycom-mcp-integration",
    "endpointUrl": "https://mcp.monday.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "monday.com",
      "monday board"
    ],
    "hosts": [
      "monday.com"
    ],
    "defaultExcludedTools": [
      "all_monday_api",
      "get_graphql_schema",
      "get_type_details",
      "get_sprint_summary",
      "create_notification"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.motherduck",
    "slug": "motherduck",
    "name": "motherduck",
    "description": "MotherDuck: query DuckDB cloud warehouses with SQL.",
    "sourceUrl": "https://motherduck.com/docs/key-tasks/ai-and-motherduck/mcp-setup/",
    "endpointUrl": "https://api.motherduck.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "motherduck",
      "duckdb"
    ],
    "hosts": [
      "motherduck.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [
      "list_columns",
      "list_databases",
      "list_macros",
      "list_shares",
      "list_tables",
      "list_views",
      "query",
      "query_rw",
      "search_catalog"
    ],
    "managed": true
  },
  {
    "id": "hermes.mcp.n8n",
    "slug": "n8n",
    "name": "n8n",
    "description": "Manage and inspect n8n workflows from Hermes (stdio bridge, no public port).",
    "sourceUrl": "https://github.com/CyberSamuraiX/hermes-n8n-mcp",
    "endpointUrl": null,
    "transport": "stdio",
    "auth": "api_key",
    "keywords": [],
    "hosts": [],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [
      "health",
      "list_workflows",
      "get_workflow",
      "find_workflows",
      "list_executions",
      "get_execution",
      "recent_failures",
      "export_workflow"
    ],
    "managed": false
  },
  {
    "id": "hermes.mcp.neon",
    "slug": "neon",
    "name": "neon",
    "description": "Neon serverless Postgres: projects, branches, and SQL.",
    "sourceUrl": "https://neon.com/docs/ai/neon-mcp-server",
    "endpointUrl": "https://mcp.neon.tech/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "neon",
      "postgres"
    ],
    "hosts": [
      "neon.tech",
      "neon.com"
    ],
    "defaultExcludedTools": [
      "search",
      "fetch",
      "list_docs_resources",
      "get_doc_resource",
      "query_logs",
      "list_log_fields",
      "list_log_field_values",
      "provision_neon_auth",
      "configure_neon_auth",
      "get_neon_auth_config"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.netlify",
    "slug": "netlify",
    "name": "netlify",
    "description": "Sites, deploys, and env vars via Netlify's hosted MCP.",
    "sourceUrl": "https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/",
    "endpointUrl": "https://netlify-mcp.netlify.app/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "netlify"
    ],
    "hosts": [
      "netlify.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.notion",
    "slug": "notion",
    "name": "notion",
    "description": "Pages and databases from your Notion workspace.",
    "sourceUrl": "https://developers.notion.com/docs/mcp",
    "endpointUrl": "https://mcp.notion.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "notion"
    ],
    "hosts": [
      "notion.so",
      "notion.site"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.paypal",
    "slug": "paypal",
    "name": "paypal",
    "description": "Payments, invoices, and subscriptions via PayPal's hosted MCP.",
    "sourceUrl": "https://developer.paypal.com/tools/mcp-server/",
    "endpointUrl": "https://mcp.paypal.com/sse",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "paypal"
    ],
    "hosts": [
      "developer.paypal.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.plaid",
    "slug": "plaid",
    "name": "plaid",
    "description": "Plaid dashboard: integrations, Items, and usage debugging.",
    "sourceUrl": "https://plaid.com/docs/resources/mcp/",
    "endpointUrl": "https://api.dashboard.plaid.com/mcp/",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "plaid"
    ],
    "hosts": [
      "plaid.com"
    ],
    "defaultExcludedTools": [
      "plaid_get_tools_introduction"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.postman",
    "slug": "postman",
    "name": "postman",
    "description": "Postman workspaces, collections, environments, and APIs.",
    "sourceUrl": "https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server/",
    "endpointUrl": "https://mcp.postman.com/minimal",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "postman",
      "api collection"
    ],
    "hosts": [
      "postman.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.prisma-postgres",
    "slug": "prisma-postgres",
    "name": "prisma-postgres",
    "description": "Create and manage Prisma Postgres databases.",
    "sourceUrl": "https://www.prisma.io/docs/postgres/integrations/mcp-server",
    "endpointUrl": "https://mcp.prisma.io/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "prisma"
    ],
    "hosts": [
      "prisma.io"
    ],
    "defaultExcludedTools": [
      "search_prisma_documentation"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.railway",
    "slug": "railway",
    "name": "railway",
    "description": "Railway: projects, services, deployments, and environments.",
    "sourceUrl": "https://docs.railway.com/guides/mcp-server",
    "endpointUrl": "https://mcp.railway.com",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "railway",
      "railway deploy"
    ],
    "hosts": [
      "railway.com",
      "railway.app"
    ],
    "defaultExcludedTools": [
      "railway-agent"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.robinhood",
    "slug": "robinhood",
    "name": "robinhood",
    "description": "Robinhood agentic trading: portfolio, balances, and orders.",
    "sourceUrl": "https://robinhood.com/us/en/support/articles/agentic-trading-overview/",
    "endpointUrl": "https://agent.robinhood.com/mcp/trading",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "robinhood",
      "stock trade"
    ],
    "hosts": [
      "robinhood.com"
    ],
    "defaultExcludedTools": [
      "get_option_level_upgrade_info",
      "get_popular_watchlists",
      "follow_watchlist",
      "unfollow_watchlist"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.semgrep",
    "slug": "semgrep",
    "name": "semgrep",
    "description": "Scan code for security vulnerabilities with Semgrep.",
    "sourceUrl": "https://semgrep.dev/docs/mcp",
    "endpointUrl": "https://mcp.semgrep.ai/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "semgrep",
      "static analysis"
    ],
    "hosts": [
      "semgrep.dev"
    ],
    "defaultExcludedTools": [
      "security_check",
      "supported_languages",
      "semgrep_rule_schema"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.sentry",
    "slug": "sentry",
    "name": "sentry",
    "description": "Issues, stack traces, and error context from Sentry.",
    "sourceUrl": "https://docs.sentry.io/product/sentry-mcp/",
    "endpointUrl": "https://mcp.sentry.dev/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "sentry",
      "stack trace",
      "crash report"
    ],
    "hosts": [
      "sentry.io"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.square",
    "slug": "square",
    "name": "square",
    "description": "Catalog, orders, and payments via Square's hosted MCP.",
    "sourceUrl": "https://developer.squareup.com/docs/mcp",
    "endpointUrl": "https://mcp.squareup.com/sse",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "squareup"
    ],
    "hosts": [
      "squareup.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.strava",
    "slug": "strava",
    "name": "strava",
    "description": "Strava: activities, fitness trends, training load (read-only).",
    "sourceUrl": "https://support.strava.com/en-us/articles/15401531-strava-mcp-connector",
    "endpointUrl": "https://mcp.strava.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "strava",
      "running",
      "cycling"
    ],
    "hosts": [
      "strava.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.stripe",
    "slug": "stripe",
    "name": "stripe",
    "description": "Payments, customers, and invoices via Stripe's hosted MCP.",
    "sourceUrl": "https://docs.stripe.com/mcp",
    "endpointUrl": "https://mcp.stripe.com",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "stripe"
    ],
    "hosts": [
      "dashboard.stripe.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.supabase",
    "slug": "supabase",
    "name": "supabase",
    "description": "Database, auth, and storage from your Supabase projects.",
    "sourceUrl": "https://supabase.com/docs/guides/ai-tools/mcp",
    "endpointUrl": "https://mcp.supabase.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "supabase"
    ],
    "hosts": [
      "supabase.com",
      "supabase.co"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.todoist",
    "slug": "todoist",
    "name": "todoist",
    "description": "Manage Todoist tasks and projects.",
    "sourceUrl": "https://www.todoist.com/help/articles/todoist-mcp-server",
    "endpointUrl": "https://ai.todoist.net/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "todoist",
      "todo"
    ],
    "hosts": [
      "todoist.com"
    ],
    "defaultExcludedTools": [
      "search",
      "fetch",
      "export-project-template",
      "import-project-template"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.trivago",
    "slug": "trivago",
    "name": "trivago",
    "description": "trivago hotel search: compare prices by city and dates.",
    "sourceUrl": "https://mcp.trivago.com/mcp",
    "endpointUrl": "https://mcp.trivago.com/mcp",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "hotel search",
      "trivago"
    ],
    "hosts": [
      "trivago.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.twelve-data",
    "slug": "twelve-data",
    "name": "twelve-data",
    "description": "Stocks, forex, and crypto market data from Twelve Data.",
    "sourceUrl": "https://twelvedata.com/docs",
    "endpointUrl": "https://mcp.twelvedata.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "twelve data",
      "stock price"
    ],
    "hosts": [
      "twelvedata.com"
    ],
    "defaultExcludedTools": [
      "oauth_login",
      "auth_status",
      "oauth_configure",
      "get_api_usage"
    ],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.twilio-docs",
    "slug": "twilio-docs",
    "name": "twilio-docs",
    "description": "Twilio developer docs search (public beta, read-only).",
    "sourceUrl": "https://www.twilio.com/docs/ai/mcp",
    "endpointUrl": "https://mcp.twilio.com/docs",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "twilio docs"
    ],
    "hosts": [
      "twilio.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.unreal-engine",
    "slug": "unreal-engine",
    "name": "unreal-engine",
    "description": "Drive the Unreal Engine 5.8 editor over its local MCP server.",
    "sourceUrl": "https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor",
    "endpointUrl": "http://127.0.0.1:8000/mcp",
    "transport": "http",
    "auth": "none",
    "keywords": [],
    "hosts": [],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.vercel",
    "slug": "vercel",
    "name": "vercel",
    "description": "Deployments, logs, and projects via Vercel's hosted MCP.",
    "sourceUrl": "https://vercel.com/docs/mcp",
    "endpointUrl": "https://mcp.vercel.com",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "vercel"
    ],
    "hosts": [
      "vercel.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.webflow",
    "slug": "webflow",
    "name": "webflow",
    "description": "Sites, CMS collections, and pages via Webflow's hosted MCP.",
    "sourceUrl": "https://developers.webflow.com/mcp/reference/getting-started",
    "endpointUrl": "https://mcp.webflow.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "webflow"
    ],
    "hosts": [
      "webflow.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.wolfram",
    "slug": "wolfram",
    "name": "wolfram",
    "description": "Wolfram|Alpha computation, math, and curated knowledge.",
    "sourceUrl": "https://www.wolfram.com/agent-tools/",
    "endpointUrl": "https://agenttools.wolfram.com/mcp",
    "transport": "http",
    "auth": "none",
    "keywords": [
      "wolfram",
      "wolfram alpha",
      "computation"
    ],
    "hosts": [
      "wolfram.com",
      "wolframalpha.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  },
  {
    "id": "hermes.mcp.wordpress-com",
    "slug": "wordpress-com",
    "name": "wordpress-com",
    "description": "WordPress.com: posts, pages, drafts, stats, and comments.",
    "sourceUrl": "https://developer.wordpress.com/docs/mcp/",
    "endpointUrl": "https://public-api.wordpress.com/wpcom/v2/mcp/v1",
    "transport": "http",
    "auth": "oauth",
    "keywords": [
      "wordpress"
    ],
    "hosts": [
      "wordpress.com"
    ],
    "defaultExcludedTools": [],
    "defaultEnabledTools": [],
    "managed": true
  }
] as const satisfies readonly HermesMcpCatalogEntry[];

export const HERMES_SKILL_CATALOG = [
  {
    "id": "hermes.skill.autonomous-ai-agents.agent-merge-conflict-arbiter",
    "slug": "autonomous-ai-agents/agent-merge-conflict-arbiter",
    "name": "agent-merge-conflict-arbiter",
    "description": "Neutral arbiter for merge conflicts between two agents.",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "autonomous-ai-agents",
    "tags": [
      "Multi-Agent",
      "Git",
      "Merge-Conflict",
      "Kanban",
      "Arbitration"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/agent-merge-conflict-arbiter",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/agent-merge-conflict-arbiter/SKILL.md"
  },
  {
    "id": "hermes.skill.autonomous-ai-agents.antigravity-cli",
    "slug": "autonomous-ai-agents/antigravity-cli",
    "name": "antigravity-cli",
    "description": "Operate the Antigravity CLI (agy): plugins, auth, sandbox.",
    "version": "0.2.0",
    "author": "Tony Simons (asimons81), Hermes Agent",
    "license": "MIT",
    "category": "autonomous-ai-agents",
    "tags": [
      "Coding-Agent",
      "Antigravity",
      "CLI",
      "Auth",
      "Plugins",
      "Sandbox"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/antigravity-cli",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/antigravity-cli/SKILL.md"
  },
  {
    "id": "hermes.skill.autonomous-ai-agents.blackbox",
    "slug": "autonomous-ai-agents/blackbox",
    "name": "blackbox",
    "description": "Delegate coding tasks to the Blackbox AI multi-model CLI.",
    "version": "1.0.1",
    "author": "Hermes Agent (Nous Research)",
    "license": "MIT",
    "category": "autonomous-ai-agents",
    "tags": [
      "Coding-Agent",
      "Blackbox",
      "Multi-Agent",
      "Judge",
      "Multi-Model"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/blackbox",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/blackbox/SKILL.md"
  },
  {
    "id": "hermes.skill.autonomous-ai-agents.grok",
    "slug": "autonomous-ai-agents/grok",
    "name": "grok",
    "description": "Delegate coding to xAI Grok Build CLI (features, PRs).",
    "version": "0.1.1",
    "author": "Matt Maximo (MattMaximo), Hermes Agent",
    "license": "MIT",
    "category": "autonomous-ai-agents",
    "tags": [
      "Coding-Agent",
      "Grok",
      "xAI",
      "Code-Review",
      "Refactoring",
      "Automation"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/grok",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/grok/SKILL.md"
  },
  {
    "id": "hermes.skill.autonomous-ai-agents.honcho",
    "slug": "autonomous-ai-agents/honcho",
    "name": "honcho",
    "description": "Configure and troubleshoot Honcho memory for Hermes.",
    "version": "2.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "autonomous-ai-agents",
    "tags": [
      "Honcho",
      "Memory",
      "Profiles",
      "Observation",
      "Dialectic",
      "User-Modeling",
      "Session-Summary"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/honcho",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/honcho/SKILL.md"
  },
  {
    "id": "hermes.skill.autonomous-ai-agents.openhands",
    "slug": "autonomous-ai-agents/openhands",
    "name": "openhands",
    "description": "Delegate coding to OpenHands CLI (model-agnostic, LiteLLM).",
    "version": "0.1.0",
    "author": "Tim Koepsel (xzessmedia), Hermes Agent",
    "license": "MIT",
    "category": "autonomous-ai-agents",
    "tags": [
      "Coding-Agent",
      "OpenHands",
      "Model-Agnostic",
      "LiteLLM"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/openhands",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/autonomous-ai-agents/openhands/SKILL.md"
  },
  {
    "id": "hermes.skill.blockchain.evm",
    "slug": "blockchain/evm",
    "name": "evm",
    "description": "Read-only EVM client: wallets, tokens, gas across 8 chains.",
    "version": "1.0.0",
    "author": "Mibayy (@Mibayy), youssefea (@youssefea), ethernet8023 (@ethernet8023), Hermes Agent",
    "license": "MIT",
    "category": "blockchain",
    "tags": [
      "EVM",
      "Ethereum",
      "BNB",
      "BSC",
      "Base",
      "Arbitrum",
      "Polygon",
      "Optimism",
      "Avalanche",
      "zkSync",
      "Blockchain",
      "Crypto",
      "Web3",
      "DeFi",
      "NFT",
      "ENS",
      "Whale",
      "Security"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/blockchain/evm",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/blockchain/evm/SKILL.md"
  },
  {
    "id": "hermes.skill.blockchain.hyperliquid",
    "slug": "blockchain/hyperliquid",
    "name": "hyperliquid",
    "description": "Hyperliquid market data, account history, trade review.",
    "version": "0.1.0",
    "author": "Hugo Sequier (Hugo-SEQUIER), Hermes Agent",
    "license": "MIT",
    "category": "blockchain",
    "tags": [
      "Hyperliquid",
      "Blockchain",
      "Crypto",
      "Trading",
      "Perpetuals",
      "Spot",
      "DeFi"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/blockchain/hyperliquid",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/blockchain/hyperliquid/SKILL.md"
  },
  {
    "id": "hermes.skill.blockchain.solana",
    "slug": "blockchain/solana",
    "name": "solana",
    "description": "Query Solana wallets, tokens, txs, and NFTs in USD.",
    "version": "0.2.0",
    "author": "Deniz Alagoz (gizdusum), enhanced by Hermes Agent",
    "license": "MIT",
    "category": "blockchain",
    "tags": [
      "Solana",
      "Blockchain",
      "Crypto",
      "Web3",
      "RPC",
      "DeFi",
      "NFT"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/blockchain/solana",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/blockchain/solana/SKILL.md"
  },
  {
    "id": "hermes.skill.communication.one-three-one-rule",
    "slug": "communication/one-three-one-rule",
    "name": "one-three-one-rule",
    "description": "1-3-1 decision briefs: problem, three options, one pick.",
    "version": "1.0.0",
    "author": "Willard Moore",
    "license": "MIT",
    "category": "communication",
    "tags": [
      "communication",
      "decision-making",
      "proposals",
      "trade-offs"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/communication/one-three-one-rule",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/communication/one-three-one-rule/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.ascii-art",
    "slug": "creative/ascii-art",
    "name": "ascii-art",
    "description": "ASCII art: pyfiglet, cowsay, boxes, image-to-ascii.",
    "version": "4.0.0",
    "author": "0xbyt4, Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "ASCII",
      "Art",
      "Banners",
      "Creative",
      "Unicode",
      "Text-Art",
      "pyfiglet",
      "figlet",
      "cowsay",
      "boxes"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/ascii-art",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/ascii-art/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.audiocraft-audio-generation",
    "slug": "creative/audiocraft-audio-generation",
    "name": "audiocraft-audio-generation",
    "description": "AudioCraft: MusicGen text-to-music, AudioGen text-to-sound.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "Multimodal",
      "Audio Generation",
      "Text-to-Music",
      "Text-to-Audio",
      "MusicGen"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/audiocraft-audio-generation",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/audiocraft-audio-generation/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.baoyu-article-illustrator",
    "slug": "creative/baoyu-article-illustrator",
    "name": "baoyu-article-illustrator",
    "description": "Article illustrations: type × style × palette consistency.",
    "version": "1.57.0",
    "author": "宝玉 (JimLiu)",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "article-illustration",
      "creative",
      "image-generation"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/baoyu-article-illustrator",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/baoyu-article-illustrator/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.baoyu-comic",
    "slug": "creative/baoyu-comic",
    "name": "baoyu-comic",
    "description": "Knowledge comics (知识漫画): educational, biography, tutorial.",
    "version": "1.56.1",
    "author": "宝玉 (JimLiu)",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "comic",
      "knowledge-comic",
      "creative",
      "image-generation"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/baoyu-comic",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/baoyu-comic/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.comfyui",
    "slug": "creative/comfyui",
    "name": "comfyui",
    "description": "Generate images, video, and audio via diffusion workflows.",
    "version": "5.1.0",
    "author": "[kshitijk4poor, alt-glitch, purzbeats]",
    "license": "MIT",
    "category": "creative",
    "tags": [],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/comfyui",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/comfyui/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.concept-diagrams",
    "slug": "creative/concept-diagrams",
    "name": "concept-diagrams",
    "description": "Generate flat, minimal educational SVG visuals as HTML.",
    "version": "0.1.0",
    "author": "v1k22 (original PR), ported into hermes-agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "diagrams",
      "svg",
      "visualization",
      "education",
      "physics",
      "chemistry",
      "engineering"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/concept-diagrams",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/concept-diagrams/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.creative-ideation",
    "slug": "creative/creative-ideation",
    "name": "creative-ideation",
    "description": "Generate ideas via named methods from creative practice.",
    "version": "2.1.0",
    "author": "SHL0MS",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "Creative",
      "Ideation",
      "Brainstorming",
      "Methods",
      "Inspiration"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/creative-ideation",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/creative-ideation/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.draw-your-font",
    "slug": "creative/draw-your-font",
    "name": "draw-your-font",
    "description": "Turn a handwriting photo into an installable TTF font.",
    "version": "0.1.0",
    "author": "Danilo Znamerovszkij (https://github.com/danilo-znamerovszkij/draw-your-font), ported by Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "font",
      "handwriting",
      "typography",
      "ttf",
      "woff",
      "vision",
      "creative"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/draw-your-font",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/draw-your-font/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.excalidraw",
    "slug": "creative/excalidraw",
    "name": "excalidraw",
    "description": "Hand-drawn Excalidraw JSON diagrams (arch, flow, seq).",
    "version": "1.0.1",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "Excalidraw",
      "Diagrams",
      "Flowcharts",
      "Architecture",
      "Visualization",
      "JSON"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/excalidraw",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/excalidraw/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.heartmula",
    "slug": "creative/heartmula",
    "name": "heartmula",
    "description": "HeartMuLa: Suno-like song generation from lyrics + tags.",
    "version": "1.0.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "music",
      "audio",
      "generation",
      "ai",
      "heartmula",
      "heartcodec",
      "lyrics",
      "songs"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/heartmula",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/heartmula/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.hyperframes",
    "slug": "creative/hyperframes",
    "name": "hyperframes",
    "description": "Render MP4/WebM videos from HTML compositions.",
    "version": "1.0.0",
    "author": "heygen-com",
    "license": "Apache-2.0",
    "category": "creative",
    "tags": [
      "creative",
      "video",
      "animation",
      "html",
      "gsap",
      "motion-graphics"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/hyperframes",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/hyperframes/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.impeccable",
    "slug": "creative/impeccable",
    "name": "impeccable",
    "description": "Frontend design guidance, upstream-maintained (impeccable).",
    "version": "4.1.2",
    "author": "Paul Bakaus (pbakaus)",
    "license": "Apache-2.0",
    "category": "creative",
    "tags": [
      "design",
      "frontend",
      "ui",
      "ux",
      "web-design",
      "anti-slop"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/impeccable",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/impeccable/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.kanban-video-orchestrator",
    "slug": "creative/kanban-video-orchestrator",
    "name": "kanban-video-orchestrator",
    "description": "Plan and run multi-agent video production pipelines.",
    "version": "1.0.0",
    "author": "[SHL0MS, alt-glitch]",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "video",
      "kanban",
      "multi-agent",
      "orchestration",
      "production-pipeline"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/kanban-video-orchestrator",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/kanban-video-orchestrator/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.meme-generation",
    "slug": "creative/meme-generation",
    "name": "meme-generation",
    "description": "Create meme PNGs from templates with Pillow text overlay.",
    "version": "2.0.0",
    "author": "adanaleycio",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "creative",
      "memes",
      "humor",
      "images"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/meme-generation",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/meme-generation/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.pixel-art",
    "slug": "creative/pixel-art",
    "name": "pixel-art",
    "description": "Pixel art w/ era palettes (NES, Game Boy, PICO-8).",
    "version": "2.0.0",
    "author": "dodo-reach",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "creative",
      "pixel-art",
      "arcade",
      "snes",
      "nes",
      "gameboy",
      "retro",
      "image",
      "video"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/pixel-art",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/pixel-art/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.pretext",
    "slug": "creative/pretext",
    "name": "pretext",
    "description": "Build creative browser demos with DOM-free text layout.",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "creative-coding",
      "typography",
      "pretext",
      "ascii-art",
      "canvas",
      "generative",
      "text-layout",
      "kinetic-typography"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/pretext",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/pretext/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.simple-english",
    "slug": "creative/simple-english",
    "name": "simple-english",
    "description": "Rewrite text to ASD-STE100 Simplified Technical English.",
    "version": "1.2.0",
    "author": "AminBlg (https://github.com/AminBlg/SimpleEnglish), ported by Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "writing",
      "documentation",
      "ste",
      "asd-ste100",
      "technical-writing",
      "editing",
      "anti-ai-slop"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/simple-english",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/simple-english/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.sketch",
    "slug": "creative/sketch",
    "name": "sketch",
    "description": "Throwaway HTML mockups: 2-3 design variants to compare.",
    "version": "1.0.1",
    "author": "Hermes Agent (adapted from gsd-build/get-shit-done)",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "sketch",
      "mockup",
      "design",
      "ui",
      "prototype",
      "html",
      "variants",
      "exploration",
      "wireframe",
      "comparison"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/sketch",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/sketch/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.social-media-content-calendar",
    "slug": "creative/social-media-content-calendar",
    "name": "social-media-content-calendar",
    "description": "Plan multi-platform social campaigns: briefs to posting.",
    "version": "0.1.0",
    "author": "Ben Barclay (benbarclay), Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "Social-Media",
      "Content-Calendar",
      "Campaigns",
      "Publishing"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/social-media-content-calendar",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/social-media-content-calendar/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.tldraw-offline",
    "slug": "creative/tldraw-offline",
    "name": "tldraw-offline",
    "description": "Drive and script tldraw offline canvases with an agent.",
    "version": "1.0.0",
    "author": "Teknium + Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "tldraw",
      "canvas",
      "whiteboard",
      "document-script",
      "diagramming"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/tldraw-offline",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/tldraw-offline/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.touchdesigner-mcp",
    "slug": "creative/touchdesigner-mcp",
    "name": "touchdesigner-mcp",
    "description": "Control TouchDesigner via twozero MCP.",
    "version": "1.1.0",
    "author": "kshitijk4poor",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "TouchDesigner",
      "MCP",
      "twozero",
      "creative-coding",
      "real-time-visuals",
      "generative-art",
      "audio-reactive",
      "VJ",
      "installation",
      "GLSL"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/touchdesigner-mcp",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/touchdesigner-mcp/SKILL.md"
  },
  {
    "id": "hermes.skill.creative.unreal-mcp",
    "slug": "creative/unreal-mcp",
    "name": "unreal-mcp",
    "description": "Automate Unreal Engine editor scenes, actors, and renders.",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "creative",
    "tags": [
      "unreal",
      "unreal-engine",
      "ue5",
      "3d",
      "mcp",
      "scenes",
      "cinematics",
      "lighting",
      "gamedev"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/unreal-mcp",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/creative/unreal-mcp/SKILL.md"
  },
  {
    "id": "hermes.skill.data-science.jupyter-notebook",
    "slug": "data-science/jupyter-notebook",
    "name": "jupyter-notebook",
    "description": "Iterative Python via live Jupyter kernel (hamelnb).",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "data-science",
    "tags": [
      "jupyter",
      "notebook",
      "repl",
      "data-science",
      "exploration",
      "iterative"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/data-science/jupyter-notebook",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/data-science/jupyter-notebook/SKILL.md"
  },
  {
    "id": "hermes.skill.devops.actual-setup",
    "slug": "devops/actual-setup",
    "name": "actual-setup",
    "description": "Set up Actual Computer (actual.inc) inference in Hermes.",
    "version": "2.0.0",
    "author": "shl0ms + Hermes Agent",
    "license": "MIT",
    "category": "devops",
    "tags": [
      "actual",
      "actual-inc",
      "provider",
      "local-inference",
      "relay",
      "gguf",
      "setup"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/actual-setup",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/actual-setup/SKILL.md"
  },
  {
    "id": "hermes.skill.devops.docker-management",
    "slug": "devops/docker-management",
    "name": "docker-management",
    "description": "Manage Docker containers, images, volumes, and Compose.",
    "version": "1.0.0",
    "author": "sprmn24",
    "license": "MIT",
    "category": "devops",
    "tags": [
      "docker",
      "containers",
      "devops",
      "infrastructure",
      "compose",
      "images",
      "volumes",
      "networks",
      "debugging"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/docker-management",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/docker-management/SKILL.md"
  },
  {
    "id": "hermes.skill.devops.hermes-s6-container-supervision",
    "slug": "devops/hermes-s6-container-supervision",
    "name": "hermes-s6-container-supervision",
    "description": "Modify or debug s6 services in the Hermes Docker image.",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "devops",
    "tags": [
      "docker",
      "s6",
      "supervision",
      "gateway",
      "profiles"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/hermes-s6-container-supervision",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/hermes-s6-container-supervision/SKILL.md"
  },
  {
    "id": "hermes.skill.devops.inference-sh-cli",
    "slug": "devops/inference-sh-cli",
    "name": "inference-sh-cli",
    "description": "Run 150+ AI apps (image, video, LLM) via inference.sh CLI.",
    "version": "1.0.0",
    "author": "okaris",
    "license": "MIT",
    "category": "devops",
    "tags": [
      "AI",
      "image-generation",
      "video",
      "LLM",
      "search",
      "inference",
      "FLUX",
      "Veo",
      "Claude"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/inference-sh-cli",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/inference-sh-cli/SKILL.md"
  },
  {
    "id": "hermes.skill.devops.pinggy-tunnel",
    "slug": "devops/pinggy-tunnel",
    "name": "pinggy-tunnel",
    "description": "Zero-install localhost tunnels over SSH via Pinggy.",
    "version": "0.1.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "devops",
    "tags": [
      "Pinggy",
      "Tunnel",
      "Networking",
      "SSH",
      "Webhook",
      "Localhost"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/pinggy-tunnel",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/pinggy-tunnel/SKILL.md"
  },
  {
    "id": "hermes.skill.devops.setup-wizard-generator",
    "slug": "devops/setup-wizard-generator",
    "name": "setup-wizard-generator",
    "description": "Generate a bash wizard guiding a human through manual setup.",
    "version": "1.0.0",
    "author": "Matt Pocock (mattpocock/skills, wizard) + Hermes Agent",
    "license": "MIT",
    "category": "devops",
    "tags": [
      "wizard",
      "setup",
      "onboarding",
      "credentials",
      "secrets",
      "migration",
      "bash",
      "human-in-the-loop"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/setup-wizard-generator",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/setup-wizard-generator/SKILL.md"
  },
  {
    "id": "hermes.skill.devops.watchers",
    "slug": "devops/watchers",
    "name": "watchers",
    "description": "Poll RSS, JSON APIs, and GitHub with watermark dedup.",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "devops",
    "tags": [
      "cron",
      "polling",
      "rss",
      "github",
      "http",
      "automation",
      "monitoring"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/watchers",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/devops/watchers/SKILL.md"
  },
  {
    "id": "hermes.skill.dogfood.adversarial-ux-test",
    "slug": "dogfood/adversarial-ux-test",
    "name": "adversarial-ux-test",
    "description": "Roleplay a hostile user to find and triage UX pain points.",
    "version": "1.0.0",
    "author": "Omni @ Comelse",
    "license": "MIT",
    "category": "dogfood",
    "tags": [
      "qa",
      "ux",
      "testing",
      "adversarial",
      "dogfood",
      "personas",
      "user-testing"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/dogfood/adversarial-ux-test",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/dogfood/adversarial-ux-test/SKILL.md"
  },
  {
    "id": "hermes.skill.email.agentmail",
    "slug": "email/agentmail",
    "name": "agentmail",
    "description": "Use when an agent needs AgentMail CLI email inboxes.",
    "version": "1.0.0",
    "author": "Haakam Aujla (Haakam21), AgentMail",
    "license": "MIT",
    "category": "email",
    "tags": [
      "Email",
      "CLI",
      "AgentMail",
      "Communication"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/email/agentmail",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/email/agentmail/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.3-statement-model",
    "slug": "finance/3-statement-model",
    "name": "3-statement-model",
    "description": "Build integrated IS/BS/CF financial workbooks in Excel.",
    "version": "1.0.0",
    "author": "Anthropic (adapted by Nous Research)",
    "license": "Apache-2.0",
    "category": "finance",
    "tags": [
      "finance",
      "three-statement",
      "income-statement",
      "balance-sheet",
      "cash-flow",
      "excel",
      "openpyxl",
      "modeling"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/3-statement-model",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/3-statement-model/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.comps-analysis",
    "slug": "finance/comps-analysis",
    "name": "comps-analysis",
    "description": "Build comparable-company valuation workbooks in Excel.",
    "version": "1.0.0",
    "author": "Anthropic (adapted by Nous Research)",
    "license": "Apache-2.0",
    "category": "finance",
    "tags": [
      "finance",
      "valuation",
      "comps",
      "excel",
      "openpyxl",
      "modeling",
      "investment-banking"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/comps-analysis",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/comps-analysis/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.dcf-model",
    "slug": "finance/dcf-model",
    "name": "dcf-model",
    "description": "Build discounted cash flow valuation workbooks in Excel.",
    "version": "1.0.0",
    "author": "Anthropic (adapted by Nous Research)",
    "license": "Apache-2.0",
    "category": "finance",
    "tags": [
      "finance",
      "valuation",
      "dcf",
      "excel",
      "openpyxl",
      "modeling",
      "investment-banking"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/dcf-model",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/dcf-model/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.excel-author",
    "slug": "finance/excel-author",
    "name": "excel-author",
    "description": "Build auditable financial workbooks headless via openpyxl.",
    "version": "1.0.0",
    "author": "Anthropic (adapted by Nous Research)",
    "license": "Apache-2.0",
    "category": "finance",
    "tags": [
      "excel",
      "openpyxl",
      "finance",
      "spreadsheet",
      "modeling"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/excel-author",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/excel-author/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.lbo-model",
    "slug": "finance/lbo-model",
    "name": "lbo-model",
    "description": "Build leveraged buyout workbooks with IRR/MOIC in Excel.",
    "version": "1.0.0",
    "author": "Anthropic (adapted by Nous Research)",
    "license": "Apache-2.0",
    "category": "finance",
    "tags": [
      "finance",
      "valuation",
      "lbo",
      "private-equity",
      "excel",
      "openpyxl",
      "modeling"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/lbo-model",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/lbo-model/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.merger-model",
    "slug": "finance/merger-model",
    "name": "merger-model",
    "description": "Build M&A accretion/dilution workbooks in Excel.",
    "version": "1.0.0",
    "author": "Anthropic (adapted by Nous Research)",
    "license": "Apache-2.0",
    "category": "finance",
    "tags": [
      "finance",
      "m-and-a",
      "merger",
      "accretion-dilution",
      "excel",
      "openpyxl",
      "modeling",
      "investment-banking"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/merger-model",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/merger-model/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.polymarket",
    "slug": "finance/polymarket",
    "name": "polymarket",
    "description": "Query Polymarket: markets, prices, orderbooks, history.",
    "version": "1.0.0",
    "author": "Hermes Agent + Teknium",
    "license": "MIT",
    "category": "finance",
    "tags": [],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/polymarket",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/polymarket/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.pptx-author",
    "slug": "finance/pptx-author",
    "name": "pptx-author",
    "description": "Build PowerPoint decks headless with python-pptx.",
    "version": "1.0.0",
    "author": "Anthropic (adapted by Nous Research)",
    "license": "Apache-2.0",
    "category": "finance",
    "tags": [
      "powerpoint",
      "pptx",
      "python-pptx",
      "presentation",
      "finance"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/pptx-author",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/pptx-author/SKILL.md"
  },
  {
    "id": "hermes.skill.finance.stocks",
    "slug": "finance/stocks",
    "name": "stocks",
    "description": "Stock quotes, history, search, compare, crypto via Yahoo.",
    "version": "0.1.0",
    "author": "Mibay (Mibayy), Hermes Agent",
    "license": "MIT",
    "category": "finance",
    "tags": [
      "Stocks",
      "Finance",
      "Market",
      "Crypto",
      "Investing"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/stocks",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/finance/stocks/SKILL.md"
  },
  {
    "id": "hermes.skill.gaming.minecraft-modpack-server",
    "slug": "gaming/minecraft-modpack-server",
    "name": "minecraft-modpack-server",
    "description": "Host modded Minecraft servers (CurseForge, Modrinth).",
    "version": "1.0.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "gaming",
    "tags": [],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/gaming/minecraft-modpack-server",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/gaming/minecraft-modpack-server/SKILL.md"
  },
  {
    "id": "hermes.skill.gaming.pokemon-player",
    "slug": "gaming/pokemon-player",
    "name": "pokemon-player",
    "description": "Play Pokemon via headless emulator + RAM reads.",
    "version": "1.0.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "gaming",
    "tags": [],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/gaming/pokemon-player",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/gaming/pokemon-player/SKILL.md"
  },
  {
    "id": "hermes.skill.health.fitness-nutrition",
    "slug": "health/fitness-nutrition",
    "name": "fitness-nutrition",
    "description": "Workout planning, macros, and body metrics via wger/USDA.",
    "version": "1.0.0",
    "author": "Hailey Marshall (haileymarshall), Hermes Agent",
    "license": "MIT",
    "category": "health",
    "tags": [
      "health",
      "fitness",
      "nutrition",
      "gym",
      "workout",
      "diet",
      "exercise"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/health/fitness-nutrition",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/health/fitness-nutrition/SKILL.md"
  },
  {
    "id": "hermes.skill.health.neuroskill-bci",
    "slug": "health/neuroskill-bci",
    "name": "neuroskill-bci",
    "description": "Use live BCI cognitive and mood state from NeuroSkill.",
    "version": "1.0.0",
    "author": "Hermes Agent + Nous Research",
    "license": "MIT",
    "category": "health",
    "tags": [
      "BCI",
      "neurofeedback",
      "health",
      "focus",
      "EEG",
      "cognitive-state",
      "biometrics",
      "neuroskill"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/health/neuroskill-bci",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/health/neuroskill-bci/SKILL.md"
  },
  {
    "id": "hermes.skill.mcp.fastmcp",
    "slug": "mcp/fastmcp",
    "name": "fastmcp",
    "description": "Build, test, and deploy Python MCP servers.",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "mcp",
    "tags": [
      "MCP",
      "FastMCP",
      "Python",
      "Tools",
      "Resources",
      "Prompts",
      "Deployment"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mcp/fastmcp",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mcp/fastmcp/SKILL.md"
  },
  {
    "id": "hermes.skill.mcp.mcp-oauth-remote-gateway",
    "slug": "mcp/mcp-oauth-remote-gateway",
    "name": "mcp-oauth-remote-gateway",
    "description": "Manual OAuth for remote MCP servers on headless gateways.",
    "version": "1.0.0",
    "author": "Ben Barclay (benbarclay), Hermes Agent",
    "license": "MIT",
    "category": "mcp",
    "tags": [
      "MCP",
      "OAuth",
      "PKCE",
      "Remote-Deployment"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mcp/mcp-oauth-remote-gateway",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mcp/mcp-oauth-remote-gateway/SKILL.md"
  },
  {
    "id": "hermes.skill.mcp.mcporter",
    "slug": "mcp/mcporter",
    "name": "mcporter",
    "description": "List, auth, and call MCP servers/tools from the terminal.",
    "version": "1.0.0",
    "author": "community",
    "license": "MIT",
    "category": "mcp",
    "tags": [
      "MCP",
      "Tools",
      "API",
      "Integrations",
      "Interop"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mcp/mcporter",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mcp/mcporter/SKILL.md"
  },
  {
    "id": "hermes.skill.migration.openclaw-migration",
    "slug": "migration/openclaw-migration",
    "name": "openclaw-migration",
    "description": "Import an OpenClaw setup (memories, skills) into Hermes.",
    "version": "1.0.0",
    "author": "Hermes Agent (Nous Research)",
    "license": "MIT",
    "category": "migration",
    "tags": [
      "Migration",
      "OpenClaw",
      "Hermes",
      "Memory",
      "Persona",
      "Import"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/migration/openclaw-migration",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/migration/openclaw-migration/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.accelerate",
    "slug": "mlops/accelerate",
    "name": "accelerate",
    "description": "Run PyTorch training across GPUs with minimal changes.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Distributed Training",
      "HuggingFace",
      "Accelerate",
      "DeepSpeed",
      "FSDP",
      "Mixed Precision",
      "PyTorch",
      "DDP",
      "Unified API",
      "Simple"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/accelerate",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/accelerate/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.chroma",
    "slug": "mlops/chroma",
    "name": "chroma",
    "description": "Embedding database for RAG and semantic search.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "RAG",
      "Chroma",
      "Vector Database",
      "Embeddings",
      "Semantic Search",
      "Open Source",
      "Self-Hosted",
      "Document Retrieval",
      "Metadata Filtering"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/chroma",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/chroma/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.clip",
    "slug": "mlops/clip",
    "name": "clip",
    "description": "Zero-shot image classification and image-text search.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Multimodal",
      "CLIP",
      "Vision-Language",
      "Zero-Shot",
      "Image Classification",
      "OpenAI",
      "Image Search",
      "Cross-Modal Retrieval",
      "Content Moderation"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/clip",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/clip/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.evaluation.evaluating-llms-harness",
    "slug": "mlops/evaluation/evaluating-llms-harness",
    "name": "evaluating-llms-harness",
    "description": "lm-eval-harness: benchmark LLMs (MMLU, GSM8K, etc.).",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Evaluation",
      "LM Evaluation Harness",
      "Benchmarking",
      "MMLU",
      "HumanEval",
      "GSM8K",
      "EleutherAI",
      "Model Quality",
      "Academic Benchmarks",
      "Industry Standard"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/evaluation/evaluating-llms-harness",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/evaluation/evaluating-llms-harness/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.evaluation.weights-and-biases",
    "slug": "mlops/evaluation/weights-and-biases",
    "name": "weights-and-biases",
    "description": "W&B: log ML experiments, sweeps, model registry, dashboards.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "MLOps",
      "Weights And Biases",
      "WandB",
      "Experiment Tracking",
      "Hyperparameter Tuning",
      "Model Registry",
      "Collaboration",
      "Real-Time Visualization",
      "PyTorch",
      "TensorFlow",
      "HuggingFace"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/evaluation/weights-and-biases",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/evaluation/weights-and-biases/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.faiss",
    "slug": "mlops/faiss",
    "name": "faiss",
    "description": "Fast vector similarity search at billion scale.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "RAG",
      "FAISS",
      "Similarity Search",
      "Vector Search",
      "Facebook AI",
      "GPU Acceleration",
      "Billion-Scale",
      "K-NN",
      "HNSW",
      "High Performance",
      "Large Scale"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/faiss",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/faiss/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.flash-attention",
    "slug": "mlops/flash-attention",
    "name": "flash-attention",
    "description": "Speed up long-sequence transformer training and inference.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Optimization",
      "Flash Attention",
      "Attention Optimization",
      "Memory Efficiency",
      "Speed Optimization",
      "Long Context",
      "PyTorch",
      "SDPA",
      "H100",
      "FP8",
      "Transformers"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/flash-attention",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/flash-attention/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.guidance",
    "slug": "mlops/guidance",
    "name": "guidance",
    "description": "Constrain LLM output with grammars; guarantee valid JSON.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Prompt Engineering",
      "Guidance",
      "Constrained Generation",
      "Structured Output",
      "JSON Validation",
      "Grammar",
      "Microsoft Research",
      "Format Enforcement",
      "Multi-Step Workflows"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/guidance",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/guidance/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.huggingface-tokenizers",
    "slug": "mlops/huggingface-tokenizers",
    "name": "huggingface-tokenizers",
    "description": "Fast BPE/WordPiece tokenization and custom vocab training.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Tokenization",
      "HuggingFace",
      "BPE",
      "WordPiece",
      "Unigram",
      "Fast Tokenization",
      "Rust",
      "Custom Tokenizer",
      "Alignment Tracking",
      "Production"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/huggingface-tokenizers",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/huggingface-tokenizers/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.inference.llama-cpp",
    "slug": "mlops/inference/llama-cpp",
    "name": "llama-cpp",
    "description": "llama.cpp local GGUF inference + HF Hub model discovery.",
    "version": "2.1.2",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "llama.cpp",
      "GGUF",
      "Quantization",
      "Hugging Face Hub",
      "CPU Inference",
      "Apple Silicon",
      "Edge Deployment",
      "AMD GPUs",
      "Intel GPUs",
      "NVIDIA",
      "URL-first"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/inference/llama-cpp",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/inference/llama-cpp/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.inference.outlines",
    "slug": "mlops/inference/outlines",
    "name": "outlines",
    "description": "Outlines: structured JSON/regex/Pydantic LLM generation.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Prompt Engineering",
      "Outlines",
      "Structured Generation",
      "JSON Schema",
      "Pydantic",
      "Local Models",
      "Grammar-Based Generation",
      "vLLM",
      "Transformers",
      "Type Safety"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/inference/outlines",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/inference/outlines/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.inference.serving-llms-vllm",
    "slug": "mlops/inference/serving-llms-vllm",
    "name": "serving-llms-vllm",
    "description": "vLLM: high-throughput LLM serving, OpenAI API, quantization.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "vLLM",
      "Inference Serving",
      "PagedAttention",
      "Continuous Batching",
      "High Throughput",
      "Production",
      "OpenAI API",
      "Quantization",
      "Tensor Parallelism"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/inference/serving-llms-vllm",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/inference/serving-llms-vllm/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.instructor",
    "slug": "mlops/instructor",
    "name": "instructor",
    "description": "Structured LLM outputs validated with Pydantic.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Prompt Engineering",
      "Instructor",
      "Structured Output",
      "Pydantic",
      "Data Extraction",
      "JSON Parsing",
      "Type Safety",
      "Validation",
      "Streaming",
      "OpenAI",
      "Anthropic"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/instructor",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/instructor/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.lambda-labs",
    "slug": "mlops/lambda-labs",
    "name": "lambda-labs",
    "description": "On-demand GPU cloud instances for ML training.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Infrastructure",
      "GPU Cloud",
      "Training",
      "Inference",
      "Lambda Labs"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/lambda-labs",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/lambda-labs/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.llava",
    "slug": "mlops/llava",
    "name": "llava",
    "description": "Vision-language chat: VQA, captioning, image dialogue.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "LLaVA",
      "Vision-Language",
      "Multimodal",
      "Visual Question Answering",
      "Image Chat",
      "CLIP",
      "Vicuna",
      "Conversational AI",
      "Instruction Tuning",
      "VQA"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/llava",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/llava/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.modal",
    "slug": "mlops/modal",
    "name": "modal",
    "description": "Serverless GPU cloud for ML jobs and model APIs.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Infrastructure",
      "Serverless",
      "GPU",
      "Cloud",
      "Deployment",
      "Modal"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/modal",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/modal/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.models.huggingface-hub",
    "slug": "mlops/models/huggingface-hub",
    "name": "huggingface-hub",
    "description": "HuggingFace hf CLI: search/download/upload models, datasets.",
    "version": "1.0.1",
    "author": "Hugging Face",
    "license": "MIT",
    "category": "mlops",
    "tags": [],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/models/huggingface-hub",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/models/huggingface-hub/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.models.segment-anything-model",
    "slug": "mlops/models/segment-anything-model",
    "name": "segment-anything-model",
    "description": "SAM: zero-shot image segmentation via points, boxes, masks.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Multimodal",
      "Image Segmentation",
      "Computer Vision",
      "SAM",
      "Zero-Shot"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/models/segment-anything-model",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/models/segment-anything-model/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.nemo-curator",
    "slug": "mlops/nemo-curator",
    "name": "nemo-curator",
    "description": "Curate LLM training data: dedupe, filter, PII redaction.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Data Processing",
      "NeMo Curator",
      "Data Curation",
      "GPU Acceleration",
      "Deduplication",
      "Quality Filtering",
      "NVIDIA",
      "RAPIDS",
      "PII Redaction",
      "Multimodal",
      "LLM Training Data"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/nemo-curator",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/nemo-curator/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.obliteratus",
    "slug": "mlops/obliteratus",
    "name": "obliteratus",
    "description": "OBLITERATUS: abliterate LLM refusals (diff-in-means).",
    "version": "2.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Abliteration",
      "Uncensoring",
      "Refusal-Removal",
      "LLM",
      "Weight-Projection",
      "SVD",
      "Mechanistic-Interpretability",
      "HuggingFace",
      "Model-Surgery"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/obliteratus",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/obliteratus/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.peft",
    "slug": "mlops/peft",
    "name": "peft",
    "description": "Fine-tune large LLMs with LoRA on limited GPU memory.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Fine-Tuning",
      "PEFT",
      "LoRA",
      "QLoRA",
      "Parameter-Efficient",
      "Adapters",
      "Low-Rank",
      "Memory Optimization",
      "Multi-Adapter"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/peft",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/peft/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.pinecone",
    "slug": "mlops/pinecone",
    "name": "pinecone",
    "description": "Managed vector DB for production RAG and search.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "RAG",
      "Pinecone",
      "Vector Database",
      "Managed Service",
      "Serverless",
      "Hybrid Search",
      "Production",
      "Auto-Scaling",
      "Low Latency",
      "Recommendations"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/pinecone",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/pinecone/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.pytorch-fsdp",
    "slug": "mlops/pytorch-fsdp",
    "name": "pytorch-fsdp",
    "description": "Fully sharded data-parallel training for large models.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Distributed Training",
      "PyTorch",
      "FSDP",
      "Data Parallel",
      "Sharding",
      "Mixed Precision",
      "CPU Offloading",
      "FSDP2",
      "Large-Scale Training"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/pytorch-fsdp",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/pytorch-fsdp/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.pytorch-lightning",
    "slug": "mlops/pytorch-lightning",
    "name": "pytorch-lightning",
    "description": "Clean training loops with built-in distributed support.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "PyTorch Lightning",
      "Training Framework",
      "Distributed Training",
      "DDP",
      "FSDP",
      "DeepSpeed",
      "High-Level API",
      "Callbacks",
      "Best Practices",
      "Scalable"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/pytorch-lightning",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/pytorch-lightning/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.qdrant",
    "slug": "mlops/qdrant",
    "name": "qdrant",
    "description": "Vector search engine for production RAG systems.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "RAG",
      "Vector Search",
      "Qdrant",
      "Semantic Search",
      "Embeddings",
      "Similarity Search",
      "HNSW",
      "Production",
      "Distributed"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/qdrant",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/qdrant/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.research.dspy",
    "slug": "mlops/research/dspy",
    "name": "dspy",
    "description": "DSPy: declarative LM programs, auto-optimize prompts, RAG.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Prompt Engineering",
      "DSPy",
      "Declarative Programming",
      "RAG",
      "Agents",
      "Prompt Optimization",
      "LM Programming",
      "Stanford NLP",
      "Automatic Optimization",
      "Modular AI"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/research/dspy",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/research/dspy/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.saelens",
    "slug": "mlops/saelens",
    "name": "saelens",
    "description": "Train sparse autoencoders to interpret model features.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Sparse Autoencoders",
      "SAE",
      "Mechanistic Interpretability",
      "Feature Discovery",
      "Superposition"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/saelens",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/saelens/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.simpo",
    "slug": "mlops/simpo",
    "name": "simpo",
    "description": "Reference-free preference alignment, simpler than DPO.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Post-Training",
      "SimPO",
      "Preference Optimization",
      "Alignment",
      "DPO Alternative",
      "Reference-Free",
      "LLM Alignment",
      "Efficient Training"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/simpo",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/simpo/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.slime",
    "slug": "mlops/slime",
    "name": "slime",
    "description": "RL post-training for LLMs with Megatron and SGLang.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Reinforcement Learning",
      "Megatron-LM",
      "SGLang",
      "GRPO",
      "Post-Training",
      "GLM"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/slime",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/slime/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.stable-diffusion",
    "slug": "mlops/stable-diffusion",
    "name": "stable-diffusion",
    "description": "Text-to-image generation, inpainting, and img2img.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Image Generation",
      "Stable Diffusion",
      "Diffusers",
      "Text-to-Image",
      "Multimodal",
      "Computer Vision"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/stable-diffusion",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/stable-diffusion/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.tensorrt-llm",
    "slug": "mlops/tensorrt-llm",
    "name": "tensorrt-llm",
    "description": "High-throughput LLM inference on NVIDIA GPUs.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Inference Serving",
      "TensorRT-LLM",
      "NVIDIA",
      "Inference Optimization",
      "High Throughput",
      "Low Latency",
      "Production",
      "FP8",
      "INT4",
      "In-Flight Batching",
      "Multi-GPU"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/tensorrt-llm",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/tensorrt-llm/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.torchtitan",
    "slug": "mlops/torchtitan",
    "name": "torchtitan",
    "description": "Pretrain LLMs at scale with PyTorch 4D parallelism.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Model Architecture",
      "Distributed Training",
      "TorchTitan",
      "FSDP2",
      "Tensor Parallel",
      "Pipeline Parallel",
      "Context Parallel",
      "Float8",
      "Llama",
      "Pretraining"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/torchtitan",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/torchtitan/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.training.axolotl",
    "slug": "mlops/training/axolotl",
    "name": "axolotl",
    "description": "Axolotl: YAML LLM fine-tuning (LoRA, DPO, GRPO).",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Fine-Tuning",
      "Axolotl",
      "LLM",
      "LoRA",
      "QLoRA",
      "DPO",
      "KTO",
      "ORPO",
      "GRPO",
      "YAML",
      "HuggingFace",
      "DeepSpeed",
      "Multimodal"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/training/axolotl",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/training/axolotl/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.training.trl-fine-tuning",
    "slug": "mlops/training/trl-fine-tuning",
    "name": "trl-fine-tuning",
    "description": "TRL: SFT, DPO, GRPO, RLOO reward modeling for LLM RLHF.",
    "version": "1.0.1",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Post-Training",
      "TRL",
      "Reinforcement Learning",
      "Fine-Tuning",
      "SFT",
      "DPO",
      "GRPO",
      "RLOO",
      "RLHF",
      "Preference Alignment",
      "HuggingFace"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/training/trl-fine-tuning",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/training/trl-fine-tuning/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.training.unsloth",
    "slug": "mlops/training/unsloth",
    "name": "unsloth",
    "description": "Unsloth: 2-5x faster LoRA/QLoRA fine-tuning, less VRAM.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Fine-Tuning",
      "Unsloth",
      "Fast Training",
      "LoRA",
      "QLoRA",
      "Memory-Efficient",
      "Optimization",
      "Llama",
      "Mistral",
      "Gemma",
      "Qwen"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/training/unsloth",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/training/unsloth/SKILL.md"
  },
  {
    "id": "hermes.skill.mlops.whisper",
    "slug": "mlops/whisper",
    "name": "whisper",
    "description": "Transcribe and translate speech in 99 languages.",
    "version": "1.0.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "mlops",
    "tags": [
      "Whisper",
      "Speech Recognition",
      "ASR",
      "Multimodal",
      "Multilingual",
      "OpenAI",
      "Speech-To-Text",
      "Transcription",
      "Translation",
      "Audio Processing"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/whisper",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/mlops/whisper/SKILL.md"
  },
  {
    "id": "hermes.skill.payments.mpp-agent",
    "slug": "payments/mpp-agent",
    "name": "mpp-agent",
    "description": "Pay HTTP 402 APIs via Machine Payments Protocol (MPP).",
    "version": "0.1.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "payments",
    "tags": [
      "Payments",
      "MPP",
      "HTTP-402",
      "Tempo",
      "Stripe"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/payments/mpp-agent",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/payments/mpp-agent/SKILL.md"
  },
  {
    "id": "hermes.skill.payments.stripe-link-cli",
    "slug": "payments/stripe-link-cli",
    "name": "stripe-link-cli",
    "description": "Agent payments via Stripe Link — cards, SPT, approvals.",
    "version": "0.1.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "payments",
    "tags": [
      "Payments",
      "Stripe",
      "Link",
      "Checkout",
      "MPP"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/payments/stripe-link-cli",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/payments/stripe-link-cli/SKILL.md"
  },
  {
    "id": "hermes.skill.payments.stripe-projects",
    "slug": "payments/stripe-projects",
    "name": "stripe-projects",
    "description": "Provision SaaS services + sync creds via Stripe Projects.",
    "version": "0.1.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "payments",
    "tags": [
      "Payments",
      "Stripe",
      "Projects",
      "Provisioning",
      "Infrastructure"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/payments/stripe-projects",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/payments/stripe-projects/SKILL.md"
  },
  {
    "id": "hermes.skill.productivity.canvas",
    "slug": "productivity/canvas",
    "name": "canvas",
    "description": "Fetch Canvas LMS courses and assignments via API token.",
    "version": "1.0.0",
    "author": "community",
    "license": "MIT",
    "category": "productivity",
    "tags": [
      "Canvas",
      "LMS",
      "Education",
      "Courses",
      "Assignments"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/canvas",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/canvas/SKILL.md"
  },
  {
    "id": "hermes.skill.productivity.decision-questionnaire",
    "slug": "productivity/decision-questionnaire",
    "name": "decision-questionnaire",
    "description": "Turn an unanswerable decision into a questionnaire doc.",
    "version": "1.0.0",
    "author": "Matt Pocock (mattpocock/skills, to-questionnaire) + Hermes Agent",
    "license": "MIT",
    "category": "productivity",
    "tags": [
      "questionnaire",
      "decision",
      "async",
      "stakeholder",
      "discovery",
      "communication"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/decision-questionnaire",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/decision-questionnaire/SKILL.md"
  },
  {
    "id": "hermes.skill.productivity.here-now",
    "slug": "productivity/here-now",
    "name": "here-now",
    "description": "Publish sites to {slug}.here.now and store files in Drives.",
    "version": "1.15.3",
    "author": "here.now",
    "license": "MIT",
    "category": "productivity",
    "tags": [
      "here.now",
      "herenow",
      "publish",
      "deploy",
      "hosting",
      "static-site",
      "web",
      "share",
      "URL",
      "drive",
      "storage"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/here-now",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/here-now/SKILL.md"
  },
  {
    "id": "hermes.skill.productivity.memento-flashcards",
    "slug": "productivity/memento-flashcards",
    "name": "memento-flashcards",
    "description": "Spaced-repetition flashcards: create, review, quiz, export.",
    "version": "1.0.0",
    "author": "Memento AI",
    "license": "MIT",
    "category": "productivity",
    "tags": [
      "Education",
      "Flashcards",
      "Spaced Repetition",
      "Learning",
      "Quiz",
      "YouTube"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/memento-flashcards",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/memento-flashcards/SKILL.md"
  },
  {
    "id": "hermes.skill.productivity.shop",
    "slug": "productivity/shop",
    "name": "shop",
    "description": "Shop catalog search, checkout, order tracking, returns.",
    "version": "1.0.1",
    "author": "Joe Rinaldi Johnson (joerj123), Hermes Agent",
    "license": "MIT",
    "category": "productivity",
    "tags": [
      "Shopping",
      "E-commerce",
      "Shop",
      "Products",
      "Orders",
      "Returns",
      "Checkout",
      "Reorder"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/shop",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/shop/SKILL.md"
  },
  {
    "id": "hermes.skill.productivity.shopify",
    "slug": "productivity/shopify",
    "name": "shopify",
    "description": "Query Shopify Admin/Storefront GraphQL APIs via curl.",
    "version": "1.0.0",
    "author": "community",
    "license": "MIT",
    "category": "productivity",
    "tags": [
      "Shopify",
      "E-commerce",
      "Commerce",
      "API",
      "GraphQL"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/shopify",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/shopify/SKILL.md"
  },
  {
    "id": "hermes.skill.productivity.siyuan",
    "slug": "productivity/siyuan",
    "name": "siyuan",
    "description": "Query and edit a SiYuan knowledge base via its API.",
    "version": "1.0.0",
    "author": "FEUAZUR",
    "license": "MIT",
    "category": "productivity",
    "tags": [
      "SiYuan",
      "Notes",
      "Knowledge Base",
      "PKM",
      "API"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/siyuan",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/siyuan/SKILL.md"
  },
  {
    "id": "hermes.skill.productivity.telephony",
    "slug": "productivity/telephony",
    "name": "telephony",
    "description": "Provision Twilio numbers, SMS/MMS, and AI outbound calls.",
    "version": "1.0.0",
    "author": "Nous Research",
    "license": "MIT",
    "category": "productivity",
    "tags": [
      "telephony",
      "phone",
      "sms",
      "mms",
      "voice",
      "twilio",
      "bland.ai",
      "vapi",
      "calling",
      "texting"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/telephony",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/productivity/telephony/SKILL.md"
  },
  {
    "id": "hermes.skill.research.bioinformatics",
    "slug": "research/bioinformatics",
    "name": "bioinformatics",
    "description": "Gateway to 400+ genomics and computational biology skills.",
    "version": "1.0.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "research",
    "tags": [
      "bioinformatics",
      "genomics",
      "sequencing",
      "biology",
      "research",
      "science"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/bioinformatics",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/bioinformatics/SKILL.md"
  },
  {
    "id": "hermes.skill.research.blogwatcher",
    "slug": "research/blogwatcher",
    "name": "blogwatcher",
    "description": "Monitor blogs and RSS/Atom feeds via blogwatcher-cli tool.",
    "version": "2.0.0",
    "author": "JulienTant (fork of Hyaxia/blogwatcher)",
    "license": "MIT",
    "category": "research",
    "tags": [
      "RSS",
      "Blogs",
      "Feed-Reader",
      "Monitoring"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/blogwatcher",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/blogwatcher/SKILL.md"
  },
  {
    "id": "hermes.skill.research.darwinian-evolver",
    "slug": "research/darwinian-evolver",
    "name": "darwinian-evolver",
    "description": "Evolve prompts/regex/SQL/code with Imbue's evolution loop.",
    "version": "0.1.0",
    "author": "Bihruze (Asahi0x), Hermes Agent",
    "license": "MIT",
    "category": "research",
    "tags": [
      "evolution",
      "optimization",
      "prompt-engineering",
      "research"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/darwinian-evolver",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/darwinian-evolver/SKILL.md"
  },
  {
    "id": "hermes.skill.research.domain-intel",
    "slug": "research/domain-intel",
    "name": "domain-intel",
    "description": "Passive recon of subdomains, SSL certs, WHOIS, and DNS.",
    "version": "1.0.0",
    "author": "FurkanL0, Hermes Agent",
    "license": "MIT",
    "category": "research",
    "tags": [
      "Domains",
      "OSINT",
      "DNS",
      "Research"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/domain-intel",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/domain-intel/SKILL.md"
  },
  {
    "id": "hermes.skill.research.drug-discovery",
    "slug": "research/drug-discovery",
    "name": "drug-discovery",
    "description": "Drug discovery: ChEMBL search, drug-likeness, interactions.",
    "version": "1.0.0",
    "author": "bennytimz",
    "license": "MIT",
    "category": "research",
    "tags": [
      "science",
      "chemistry",
      "pharmacology",
      "research",
      "health"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/drug-discovery",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/drug-discovery/SKILL.md"
  },
  {
    "id": "hermes.skill.research.duckduckgo-search",
    "slug": "research/duckduckgo-search",
    "name": "duckduckgo-search",
    "description": "Free keyless web, news, and image search via ddgs.",
    "version": "1.3.0",
    "author": "gamedevCloudy",
    "license": "MIT",
    "category": "research",
    "tags": [
      "search",
      "duckduckgo",
      "web-search",
      "free",
      "fallback"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/duckduckgo-search",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/duckduckgo-search/SKILL.md"
  },
  {
    "id": "hermes.skill.research.gitnexus-explorer",
    "slug": "research/gitnexus-explorer",
    "name": "gitnexus-explorer",
    "description": "Serve an interactive codebase knowledge graph web UI.",
    "version": "1.0.0",
    "author": "Hermes Agent + Teknium",
    "license": "MIT",
    "category": "research",
    "tags": [
      "gitnexus",
      "code-intelligence",
      "knowledge-graph",
      "visualization"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/gitnexus-explorer",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/gitnexus-explorer/SKILL.md"
  },
  {
    "id": "hermes.skill.research.osint-investigation",
    "slug": "research/osint-investigation",
    "name": "osint-investigation",
    "description": "Follow the money via public records and sanctions data.",
    "version": "0.1.0",
    "author": "Hermes Agent (adapted from ShinMegamiBoson/OpenPlanter, MIT)",
    "license": "MIT",
    "category": "research",
    "tags": [
      "osint",
      "investigation",
      "public-records",
      "sec",
      "sanctions",
      "corporate-registry",
      "property",
      "courts",
      "due-diligence",
      "journalism"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/osint-investigation",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/osint-investigation/SKILL.md"
  },
  {
    "id": "hermes.skill.research.parallel-cli",
    "slug": "research/parallel-cli",
    "name": "parallel-cli",
    "description": "Agent-native web search, deep research, and enrichment.",
    "version": "1.1.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "research",
    "tags": [
      "Research",
      "Web",
      "Search",
      "Deep-Research",
      "Enrichment",
      "CLI"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/parallel-cli",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/parallel-cli/SKILL.md"
  },
  {
    "id": "hermes.skill.research.pinecone-research",
    "slug": "research/pinecone-research",
    "name": "pinecone-research",
    "description": "Agent RAG and long-term memory with Pinecone.",
    "version": "1.0.0",
    "author": "immuhammadfurqan",
    "license": "MIT",
    "category": "research",
    "tags": [
      "RAG",
      "Pinecone",
      "Memory",
      "Research",
      "Vector Database",
      "Agent",
      "Retrieval"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/pinecone-research",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/pinecone-research/SKILL.md"
  },
  {
    "id": "hermes.skill.research.qmd",
    "slug": "research/qmd",
    "name": "qmd",
    "description": "Hybrid local search over notes, docs, and transcripts.",
    "version": "1.0.0",
    "author": "Hermes Agent + Teknium",
    "license": "MIT",
    "category": "research",
    "tags": [
      "Search",
      "Knowledge-Base",
      "RAG",
      "Notes",
      "MCP",
      "Local-AI"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/qmd",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/qmd/SKILL.md"
  },
  {
    "id": "hermes.skill.research.research-paper-writing",
    "slug": "research/research-paper-writing",
    "name": "research-paper-writing",
    "description": "Write ML papers for NeurIPS/ICML/ICLR: design→submit.",
    "version": "1.1.0",
    "author": "Orchestra Research",
    "license": "MIT",
    "category": "research",
    "tags": [
      "Research",
      "Paper Writing",
      "Experiments",
      "ML",
      "AI",
      "NeurIPS",
      "ICML",
      "ICLR",
      "ACL",
      "AAAI",
      "COLM",
      "LaTeX",
      "Citations",
      "Statistical Analysis"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/research-paper-writing",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/research-paper-writing/SKILL.md"
  },
  {
    "id": "hermes.skill.research.scrapling",
    "slug": "research/scrapling",
    "name": "scrapling",
    "description": "Scrape sites with stealth browsing and Cloudflare bypass.",
    "version": "1.0.0",
    "author": "FEUAZUR",
    "license": "MIT",
    "category": "research",
    "tags": [
      "Web Scraping",
      "Browser",
      "Cloudflare",
      "Stealth",
      "Crawling",
      "Spider"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/scrapling",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/scrapling/SKILL.md"
  },
  {
    "id": "hermes.skill.research.searxng-search",
    "slug": "research/searxng-search",
    "name": "searxng-search",
    "description": "Free keyless meta-search aggregating 70+ engines.",
    "version": "1.0.1",
    "author": "hermes-agent",
    "license": "MIT",
    "category": "research",
    "tags": [
      "search",
      "searxng",
      "meta-search",
      "self-hosted",
      "free",
      "fallback"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/searxng-search",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/research/searxng-search/SKILL.md"
  },
  {
    "id": "hermes.skill.security.1password",
    "slug": "security/1password",
    "name": "1password",
    "description": "Set up op CLI, sign in, and read or inject secrets.",
    "version": "1.0.0",
    "author": "arceus77-7, enhanced by Hermes Agent",
    "license": "MIT",
    "category": "security",
    "tags": [
      "security",
      "secrets",
      "1password",
      "op",
      "cli"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/1password",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/1password/SKILL.md"
  },
  {
    "id": "hermes.skill.security.godmode",
    "slug": "security/godmode",
    "name": "godmode",
    "description": "Jailbreak LLMs: Parseltongue, GODMODE, ULTRAPLINIAN.",
    "version": "1.0.0",
    "author": "Hermes Agent + Teknium",
    "license": "MIT",
    "category": "security",
    "tags": [
      "jailbreak",
      "red-teaming",
      "G0DM0D3",
      "Parseltongue",
      "GODMODE",
      "uncensoring",
      "safety-bypass",
      "prompt-engineering",
      "L1B3RT4S"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/godmode",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/godmode/SKILL.md"
  },
  {
    "id": "hermes.skill.security.oss-forensics",
    "slug": "security/oss-forensics",
    "name": "oss-forensics",
    "description": "GitHub supply-chain forensics: recovery, IOCs, reporting.",
    "version": "1.0.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "security",
    "tags": [
      "Security",
      "Forensics",
      "GitHub",
      "Supply-Chain"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/oss-forensics",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/oss-forensics/SKILL.md"
  },
  {
    "id": "hermes.skill.security.sherlock",
    "slug": "security/sherlock",
    "name": "sherlock",
    "description": "Find accounts for a username across 400+ platforms.",
    "version": "1.0.0",
    "author": "unmodeled-tyler",
    "license": "MIT",
    "category": "security",
    "tags": [
      "osint",
      "security",
      "username",
      "social-media",
      "reconnaissance"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/sherlock",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/sherlock/SKILL.md"
  },
  {
    "id": "hermes.skill.security.unbroker",
    "slug": "security/unbroker",
    "name": "unbroker",
    "description": "Autonomously remove your info from data-broker sites.",
    "version": "1.0.0",
    "author": "SHL0MS (github.com/SHL0MS)",
    "license": "MIT",
    "category": "security",
    "tags": [
      "privacy",
      "data-broker",
      "opt-out",
      "ccpa",
      "gdpr",
      "security",
      "doxxing"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/unbroker",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/unbroker/SKILL.md"
  },
  {
    "id": "hermes.skill.security.web-pentest",
    "slug": "security/web-pentest",
    "name": "web-pentest",
    "description": "Authorized web pentest: recon, proof-based exploits, report.",
    "version": "1.0.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "security",
    "tags": [
      "Security",
      "Pentest",
      "Web",
      "Recon"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/web-pentest",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/security/web-pentest/SKILL.md"
  },
  {
    "id": "hermes.skill.smart-home.openhue",
    "slug": "smart-home/openhue",
    "name": "openhue",
    "description": "Control Philips Hue lights, scenes, rooms via OpenHue CLI.",
    "version": "1.0.1",
    "author": "community",
    "license": "MIT",
    "category": "smart-home",
    "tags": [
      "Smart-Home",
      "Hue",
      "Lights",
      "IoT",
      "Automation"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/smart-home/openhue",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/smart-home/openhue/SKILL.md"
  },
  {
    "id": "hermes.skill.software-development.ast-grep",
    "slug": "software-development/ast-grep",
    "name": "ast-grep",
    "description": "AST-aware structural code search and rewrite via ast-grep.",
    "version": "1.0.0",
    "author": "Yeongyu Kim (code-yeongyu), adapted by Hermes Agent",
    "license": "MIT",
    "category": "software-development",
    "tags": [
      "ast",
      "codemod",
      "refactoring",
      "structural-search",
      "code-search",
      "rewrite",
      "tree-sitter"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/ast-grep",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/ast-grep/SKILL.md"
  },
  {
    "id": "hermes.skill.software-development.code-wiki",
    "slug": "software-development/code-wiki",
    "name": "code-wiki",
    "description": "Generate wiki docs + Mermaid diagrams for any codebase.",
    "version": "0.1.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "software-development",
    "tags": [
      "Documentation",
      "Mermaid",
      "Architecture",
      "Diagrams",
      "Wiki",
      "Code-Analysis"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/code-wiki",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/code-wiki/SKILL.md"
  },
  {
    "id": "hermes.skill.software-development.grill-me",
    "slug": "software-development/grill-me",
    "name": "grill-me",
    "description": "Adversarial plan interview before implementation.",
    "version": "2.0.0",
    "author": "Rafael Zendron (rafaumeu) + Matt Pocock (mattpocock/skills, grilling) + Hermes Agent",
    "license": "MIT",
    "category": "software-development",
    "tags": [
      "planning",
      "adversarial",
      "interview",
      "decision-tree",
      "pre-implementation",
      "review",
      "alignment"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/grill-me",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/grill-me/SKILL.md"
  },
  {
    "id": "hermes.skill.software-development.rest-graphql-debug",
    "slug": "software-development/rest-graphql-debug",
    "name": "rest-graphql-debug",
    "description": "Debug REST/GraphQL APIs: status codes, auth, schemas, repro.",
    "version": "1.2.0",
    "author": "eren-karakus0",
    "license": "MIT",
    "category": "software-development",
    "tags": [
      "api",
      "rest",
      "graphql",
      "http",
      "debugging",
      "testing",
      "curl",
      "integration"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/rest-graphql-debug",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/rest-graphql-debug/SKILL.md"
  },
  {
    "id": "hermes.skill.software-development.subagent-driven-development",
    "slug": "software-development/subagent-driven-development",
    "name": "subagent-driven-development",
    "description": "Execute plans via delegate_task subagents (2-stage review).",
    "version": "1.1.0",
    "author": "Hermes Agent (adapted from obra/superpowers)",
    "license": "MIT",
    "category": "software-development",
    "tags": [
      "delegation",
      "subagent",
      "implementation",
      "workflow",
      "parallel"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/subagent-driven-development",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/software-development/subagent-driven-development/SKILL.md"
  },
  {
    "id": "hermes.skill.web-development.cloudflare-temporary-deploy",
    "slug": "web-development/cloudflare-temporary-deploy",
    "name": "cloudflare-temporary-deploy",
    "description": "Deploy a Worker live, no account, via wrangler --temporary.",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "web-development",
    "tags": [
      "cloudflare",
      "workers",
      "wrangler",
      "deploy",
      "temporary",
      "agent",
      "serverless",
      "web-development"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/web-development/cloudflare-temporary-deploy",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/web-development/cloudflare-temporary-deploy/SKILL.md"
  },
  {
    "id": "hermes.skill.web-development.har-derived-api-client",
    "slug": "web-development/har-derived-api-client",
    "name": "har-derived-api-client",
    "description": "Record a site's XHR into a HAR, derive an HTTP client.",
    "version": "0.1.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "web-development",
    "tags": [
      "Browser",
      "HAR",
      "API",
      "Reverse-Engineering",
      "Playwright"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/web-development/har-derived-api-client",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/web-development/har-derived-api-client/SKILL.md"
  },
  {
    "id": "hermes.skill.web-development.page-agent",
    "slug": "web-development/page-agent",
    "name": "page-agent",
    "description": "Embed an in-page natural-language GUI copilot in web apps.",
    "version": "1.0.0",
    "author": "Hermes Agent",
    "license": "MIT",
    "category": "web-development",
    "tags": [
      "web",
      "javascript",
      "agent",
      "browser",
      "gui",
      "alibaba",
      "embed",
      "copilot",
      "saas"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/web-development/page-agent",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/web-development/page-agent/SKILL.md"
  },
  {
    "id": "hermes.skill.web-development.publish-site",
    "slug": "web-development/publish-site",
    "name": "publish-site",
    "description": "Versioned site deploys to GitHub/Cloudflare/Netlify Pages.",
    "version": "1.0.0",
    "author": "Hermes Agent (Nous Research)",
    "license": "MIT",
    "category": "web-development",
    "tags": [
      "publish",
      "deploy",
      "hosting",
      "github-pages",
      "cloudflare-pages",
      "netlify",
      "static-site",
      "versioning",
      "rollback",
      "web-development"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/web-development/publish-site",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/web-development/publish-site/SKILL.md"
  },
  {
    "id": "hermes.skill.yuanbao",
    "slug": "yuanbao",
    "name": "yuanbao",
    "description": "Yuanbao (元宝) groups: @mention users, query info/members.",
    "version": "1.0.0",
    "author": "Teknium (teknium1), Hermes Agent",
    "license": "MIT",
    "category": "general",
    "tags": [
      "yuanbao",
      "mention",
      "at",
      "group",
      "members",
      "元宝",
      "派",
      "艾特"
    ],
    "sourceUrl": "https://github.com/NousResearch/hermes-agent/tree/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/yuanbao",
    "rawUrl": "https://raw.githubusercontent.com/NousResearch/hermes-agent/9a84bee265daad14340a80d7585928cd8ea1f9eb/optional-skills/yuanbao/SKILL.md"
  }
] as const satisfies readonly HermesSkillCatalogEntry[];

export function getHermesMcpCatalogEntry(id: string) {
  return HERMES_MCP_CATALOG.find((entry) => entry.id === id || entry.slug === id);
}

export function getHermesSkillCatalogEntry(id: string) {
  return HERMES_SKILL_CATALOG.find((entry) => entry.id === id || entry.slug === id);
}
