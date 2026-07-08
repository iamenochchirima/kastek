import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/__docusaurus/debug',
    component: ComponentCreator('/__docusaurus/debug', '5ff'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/config',
    component: ComponentCreator('/__docusaurus/debug/config', '5ba'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/content',
    component: ComponentCreator('/__docusaurus/debug/content', 'a2b'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/globalData',
    component: ComponentCreator('/__docusaurus/debug/globalData', 'c3c'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/metadata',
    component: ComponentCreator('/__docusaurus/debug/metadata', '156'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/registry',
    component: ComponentCreator('/__docusaurus/debug/registry', '88c'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/routes',
    component: ComponentCreator('/__docusaurus/debug/routes', '000'),
    exact: true
  },
  {
    path: '/',
    component: ComponentCreator('/', '3b3'),
    routes: [
      {
        path: '/',
        component: ComponentCreator('/', '8cc'),
        routes: [
          {
            path: '/',
            component: ComponentCreator('/', 'c12'),
            routes: [
              {
                path: '/architecture/project-plan',
                component: ComponentCreator('/architecture/project-plan', 'edc'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/contracts/n8n-provisioner-contract',
                component: ComponentCreator('/contracts/n8n-provisioner-contract', '446'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/execution/tenant-platform-execution-plan',
                component: ComponentCreator('/execution/tenant-platform-execution-plan', '420'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/go-to-market/sales-and-social-plan',
                component: ComponentCreator('/go-to-market/sales-and-social-plan', '0dc'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/roadmap/product-roadmap',
                component: ComponentCreator('/roadmap/product-roadmap', 'ee6'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/strategy/company-strategy',
                component: ComponentCreator('/strategy/company-strategy', 'e88'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/',
                component: ComponentCreator('/', '51e'),
                exact: true,
                sidebar: "tutorialSidebar"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
