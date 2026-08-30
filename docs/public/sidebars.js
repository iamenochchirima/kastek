/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docsSidebar: [
    "intro",
    {
      type: "category",
      label: "Getting Started",
      items: [
        "getting-started/overview",
        "getting-started/accessing-your-workspace",
        "getting-started/roles-and-permissions",
      ],
    },
    {
      type: "category",
      label: "Workspace",
      items: [
        "workspace/domains-and-branding",
        "workspace/email-sending",
        "workspace/settings",
      ],
    },
    {
      type: "category",
      label: "Operations",
      items: [
        "operations/dashboard",
        "operations/clients",
        "operations/leads",
        "operations/conversations",
        "operations/audio-input",
        "operations/social-connections",
      ],
    },
    {
      type: "category",
      label: "Client Portal",
      items: ["client-portal/client-experience"],
    },
    {
      type: "category",
      label: "API",
      items: [
        "api/public-v1",
        "api/agent-connection-guide",
        "api/agent-rest",
        "api/mcp-integration",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: [
        "reference/implemented-features",
        "reference/url-structure",
      ],
    },
  ],
};

module.exports = sidebars;
