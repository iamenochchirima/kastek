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
      ],
    },
    {
      type: "category",
      label: "Client Portal",
      items: ["client-portal/client-experience"],
    },
    {
      type: "category",
      label: "Modules",
      items: [
        "modules/content-pipeline",
        "modules/reporting",
        "modules/nurturing",
        "modules/aeo",
        "modules/reputation",
        "modules/voice-agents",
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
