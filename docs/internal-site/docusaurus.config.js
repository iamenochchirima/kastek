// @ts-check

const path = require("path");

const config = {
  title: "KasiTek Internal Docs",
  tagline: "Private strategy, architecture, and execution documentation",
  url: "https://internal-docs.kasitek.co.za",
  baseUrl: "/",
  organizationName: "kasitek",
  projectName: "internal-docs",
  onBrokenLinks: "throw",
  markdown: {
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
  themeConfig: {
    navbar: {
      title: "KasiTek Internal",
      items: [
        { to: "/", label: "Home", position: "left" },
        { to: "/architecture/project-plan", label: "Architecture", position: "left" },
        { to: "/execution/tenant-platform-execution-plan", label: "Execution", position: "left" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Core",
          items: [
            { label: "Internal Home", to: "/" },
            { label: "Project Plan", to: "/architecture/project-plan" },
            { label: "Tenant Platform Plan", to: "/execution/tenant-platform-execution-plan" },
          ],
        },
        {
          title: "Strategy",
          items: [
            { label: "Company Strategy", to: "/strategy/company-strategy" },
            { label: "Product Roadmap", to: "/roadmap/product-roadmap" },
            { label: "Go To Market", to: "/go-to-market/sales-and-social-plan" },
          ],
        },
      ],
      copyright: `Internal use only. Copyright ${new Date().getFullYear()} KasiTek`,
    },
  },
};

module.exports = config;
