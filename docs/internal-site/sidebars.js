/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  tutorialSidebar: [
    "README",
    {
      type: "category",
      label: "Architecture",
      items: ["architecture/PROJECT_PLAN"],
    },
    {
      type: "category",
      label: "Execution",
      items: ["execution/TENANT_PLATFORM_EXECUTION_PLAN"],
    },
    {
      type: "category",
      label: "Strategy",
      items: ["strategy/company-strategy"],
    },
    {
      type: "category",
      label: "Roadmap",
      items: ["roadmap/product-roadmap"],
    },
    {
      type: "category",
      label: "Go To Market",
      items: ["go-to-market/sales-and-social-plan"],
    },
    {
      type: "category",
      label: "Contracts",
      items: ["contracts/n8n-provisioner-contract"],
    },
  ],
};

module.exports = sidebars;
