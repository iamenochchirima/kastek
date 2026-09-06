// @ts-check

const path = require("path");

const config = {
  title: "Kasitek Internal Docs",
  tagline: "Private technical documentation",
  url: "https://internal-docs.kasitek.co.za",
  baseUrl: "/",
  organizationName: "kasitek",
  projectName: "internal-docs",
  onBrokenLinks: "throw",
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },
  presets: [
    [
      "classic",
      {
        docs: {
          path: path.resolve(__dirname, "../internal"),
          sidebarPath: require.resolve("./sidebars.js"),
          routeBasePath: "/",
          exclude: ["**/*.docx", "**/.gitkeep"],
        },
        blog: false,
        theme: {
          customCss: require.resolve("./src/css/custom.css"),
        },
      },
    ],
  ],
  plugins: [
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "agentPlatformPlan",
        path: path.resolve(__dirname, "../plans"),
        routeBasePath: "/plans/agents",
        sidebarPath: require.resolve("./agent-platform-plan-sidebars.js"),
        include: [
          "agents/AGENT_PLATFORM_IMPLEMENTATION_PLAN.md",
          "active/AGENT_PLATFORM_HOST_BOUNDARY_RESTRUCTURE_PLAN.md",
          "active/AGENT_PLATFORM_HERMES_ALIGNED_RUNTIME_RELIABILITY_PLAN.md",
        ],
        showLastUpdateAuthor: false,
        showLastUpdateTime: true,
      },
    ],
  ],
  themes: ["@docusaurus/theme-mermaid"],
  themeConfig: {
    navbar: {
      title: "Kasitek Internal",
      items: [
        { to: "/", label: "Home", position: "left" },
        { to: "/development", label: "Development", position: "left" },
        { to: "/architecture", label: "Architecture", position: "left" },
        { to: "/plans/agents/", label: "Agent Platform Plan", position: "left" },
        { to: "/operations/release-process", label: "Operations", position: "left" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Technical Docs",
          items: [
            { label: "Internal Home", to: "/" },
            { label: "Development", to: "/development" },
            { label: "Release Process", to: "/operations/release-process" },
            { label: "Runbooks", to: "/runbooks/admin-operations" },
          ],
        },
        {
          title: "Architecture",
          items: [
            { label: "Architecture", to: "/architecture" },
          ],
        },
      ],
      copyright: `Internal use only. Copyright ${new Date().getFullYear()} Kasitek Labs`,
    },
  },
};

module.exports = config;
