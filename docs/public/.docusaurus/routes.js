import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/',
    component: ComponentCreator('/', '441'),
    routes: [
      {
        path: '/',
        component: ComponentCreator('/', '9c9'),
        routes: [
          {
            path: '/',
            component: ComponentCreator('/', '242'),
            routes: [
              {
                path: '/client-portal/client-experience',
                component: ComponentCreator('/client-portal/client-experience', '174'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/getting-started/accessing-your-workspace',
                component: ComponentCreator('/getting-started/accessing-your-workspace', 'b34'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/getting-started/overview',
                component: ComponentCreator('/getting-started/overview', 'c5a'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/getting-started/roles-and-permissions',
                component: ComponentCreator('/getting-started/roles-and-permissions', 'eaf'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/intro',
                component: ComponentCreator('/intro', '4a2'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/modules/aeo',
                component: ComponentCreator('/modules/aeo', '626'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/modules/content-pipeline',
                component: ComponentCreator('/modules/content-pipeline', '667'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/modules/nurturing',
                component: ComponentCreator('/modules/nurturing', '953'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/modules/reporting',
                component: ComponentCreator('/modules/reporting', '4fe'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/modules/reputation',
                component: ComponentCreator('/modules/reputation', '958'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/modules/voice-agents',
                component: ComponentCreator('/modules/voice-agents', '62a'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/operations/clients',
                component: ComponentCreator('/operations/clients', 'bf7'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/operations/conversations',
                component: ComponentCreator('/operations/conversations', '0fb'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/operations/dashboard',
                component: ComponentCreator('/operations/dashboard', '6d3'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/operations/leads',
                component: ComponentCreator('/operations/leads', 'adf'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/reference/implemented-features',
                component: ComponentCreator('/reference/implemented-features', '0b0'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/reference/url-structure',
                component: ComponentCreator('/reference/url-structure', '59a'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/workspace/domains-and-branding',
                component: ComponentCreator('/workspace/domains-and-branding', 'afb'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/workspace/email-sending',
                component: ComponentCreator('/workspace/email-sending', '2b6'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/workspace/settings',
                component: ComponentCreator('/workspace/settings', 'aee'),
                exact: true,
                sidebar: "docsSidebar"
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
