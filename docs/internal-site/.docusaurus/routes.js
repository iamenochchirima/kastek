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
    component: ComponentCreator('/', 'd4c'),
    routes: [
      {
        path: '/',
        component: ComponentCreator('/', '0d5'),
        routes: [
          {
            path: '/',
            component: ComponentCreator('/', '60f'),
            routes: [
              {
                path: '/architecture',
                component: ComponentCreator('/architecture', '4a4'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/architecture/project-plan',
                component: ComponentCreator('/architecture/project-plan', 'ca3'),
                exact: true
              },
              {
                path: '/contracts/n8n-provisioner-contract',
                component: ComponentCreator('/contracts/n8n-provisioner-contract', 'dfc'),
                exact: true
              },
              {
                path: '/execution/tenant-platform-execution-plan',
                component: ComponentCreator('/execution/tenant-platform-execution-plan', '3c2'),
                exact: true
              },
              {
                path: '/features',
                component: ComponentCreator('/features', 'bc1'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/go-to-market/sales-and-social-plan',
                component: ComponentCreator('/go-to-market/sales-and-social-plan', '89d'),
                exact: true
              },
              {
                path: '/roadmap/product-roadmap',
                component: ComponentCreator('/roadmap/product-roadmap', 'ee6'),
                exact: true,
                sidebar: "tutorialSidebar"
              },
              {
                path: '/strategy/company-strategy',
                component: ComponentCreator('/strategy/company-strategy', '5b1'),
                exact: true
              },
              {
                path: '/white-paper/kasitek-white-paper',
                component: ComponentCreator('/white-paper/kasitek-white-paper', '96d'),
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
