// @ts-check

const path = require("path");

const config = {
  title: "Kasitek Internal Docs",
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
      title: "Kasitek Internal",
      items: [
        { to: "/", label: "Home", position: "left" },
        { to: "/features", label: "Features", position: "left" },
        { to: "/white-paper/kasitek-white-paper", label: "White Paper", position: "left" },
        { to: "/roadmap/product-roadmap", label: "Roadmap", position: "left" },
        { to: "/architecture", label: "Architecture", position: "left" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Main Docs",
          items: [
            { label: "Product Features", to: "/features" },
            { label: "White Paper", to: "/white-paper/kasitek-white-paper" },
            { label: "Product Roadmap", to: "/roadmap/product-roadmap" },
          ],
        },
        {
          title: "Architecture",
          items: [
            { label: "Internal Home", to: "/" },
            { label: "Architecture", to: "/architecture" },
          ],
        },
      ],
      copyright: `Internal use only. Copyright ${new Date().getFullYear()} Kasitek Labs`,
    },
  },
};

module.exports = config;
