/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  tutorialSidebar: [
    "README",
    "development/development",
    "development/local-development",
    "development/repository-structure",
    "architecture/kasitek-technical-blueprint",
    "architecture/credit-billing-coverage",
    "architecture/action-platform-technical-design",
    "architecture/calls-core-consolidation",
    "architecture/client-database-migration-baseline",
    "access-control",
    "contracts/contracts",
    "contracts/contact-data-lifecycle",
    "operations/release-process",
    "operations/platform-versioning",
    "operations/environments",
    "operations/observability",
    "operations/agent-memory-observability",
    "operations/documentation-maintenance",
    {
      type: "category",
      label: "Runbooks",
      items: [
        "runbooks/admin-operations",
        "runbooks/connection-failures",
        "runbooks/instagram-direct-login",
        "runbooks/paystack-billing",
        "runbooks/paystack-test-mode",
      ],
    },
  ],
};

module.exports = sidebars;
