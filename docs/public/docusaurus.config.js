// @ts-check

const config = {
  title: "KasiTek Docs",
  tagline: "Product and platform documentation",
  favicon: "img/favicon.svg",

  url: "https://docs.kasitek.co.za",
  baseUrl: "/",

  organizationName: "kasitek",
  projectName: "docs",

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
          sidebarPath: require.resolve("./sidebars.js"),
          routeBasePath: "/",
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
      title: "KasiTek Docs",
      items: [
        { to: "/", label: "Docs", position: "left" },
        { to: "/reference/implemented-features", label: "Reference", position: "left" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Getting Started", to: "/getting-started/overview" },
            { label: "Workspace Setup", to: "/workspace/domains-and-branding" },
            { label: "Client Portal", to: "/client-portal/client-experience" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "Lead Pipeline", to: "/operations/leads" },
            { label: "Email Sending", to: "/workspace/email-sending" },
            { label: "API", to: "/api/public-v1" },
            { label: "URL Structure", to: "/reference/url-structure" },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} KasiTek`,
    },
  },
};

module.exports = config;
