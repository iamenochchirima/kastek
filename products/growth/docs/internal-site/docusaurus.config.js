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
  themes: ["@docusaurus/theme-mermaid"],
  themeConfig: {
    navbar: {
      title: "Kasitek Internal",
      items: [
        { to: "/", label: "Home", position: "left" },
        { to: "/development", label: "Development", position: "left" },
        { to: "/architecture", label: "Architecture", position: "left" },
        {
          href: "https://github.com/Kasitek-Labs/kastek/tree/main/products/agents/docs",
          label: "Agent Platform",
          position: "left",
        },
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
