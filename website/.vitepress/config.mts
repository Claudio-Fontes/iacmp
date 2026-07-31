import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/iacmp/',
  title: 'iacmp',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/iacmp/logo.svg' }]],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      description: 'Multi-cloud infrastructure as code — one TypeScript codebase, CloudFormation, Bicep and Terraform out.',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started' },
          { text: 'Claude Code', link: '/guide/claude-code' },
          { text: 'npm', link: 'https://www.npmjs.com/package/iacmp' },
        ],
        sidebar: [
          {
            text: 'Guide',
            items: [
              { text: 'Getting started (5 min)', link: '/guide/getting-started' },
              { text: 'Cloud accounts and CLIs', link: '/guide/cloud-setup' },
              { text: 'Using with Claude Code', link: '/guide/claude-code' },
              { text: 'Commands', link: '/guide/commands' },
            ],
          },
        ],
        editLink: {
          pattern: 'https://github.com/Claudio-Fontes/iacmp/edit/main/website/:path',
          text: 'Edit this page on GitHub',
        },
        footer: {
          message: 'Released under the Apache-2.0 License.',
          copyright: '© 2026 Claudio Melo — creator and maintainer',
        },
      },
    },
    pt: {
      label: 'Português',
      lang: 'pt-BR',
      link: '/pt/',
      description: 'Infraestrutura como código multi-cloud — um código TypeScript, CloudFormation, Bicep e Terraform na saída.',
      themeConfig: {
        nav: [
          { text: 'Guia', link: '/pt/guide/getting-started' },
          { text: 'Claude Code', link: '/pt/guide/claude-code' },
          { text: 'npm', link: 'https://www.npmjs.com/package/iacmp' },
        ],
        sidebar: [
          {
            text: 'Guia',
            items: [
              { text: 'Comece em 5 minutos', link: '/pt/guide/getting-started' },
              { text: 'Contas de nuvem e CLIs', link: '/pt/guide/cloud-setup' },
              { text: 'Usando com Claude Code', link: '/pt/guide/claude-code' },
              { text: 'Comandos', link: '/pt/guide/commands' },
            ],
          },
        ],
        editLink: {
          pattern: 'https://github.com/Claudio-Fontes/iacmp/edit/main/website/:path',
          text: 'Editar esta página no GitHub',
        },
        footer: {
          message: 'Publicado sob a licença Apache-2.0.',
          copyright: '© 2026 Claudio Melo — criador e mantenedor',
        },
        outline: { label: 'Nesta página' },
        docFooter: { prev: 'Anterior', next: 'Próxima' },
        darkModeSwitchLabel: 'Tema',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Voltar ao topo',
        langMenuLabel: 'Idioma',
      },
    },
  },

  themeConfig: {
    logo: '/logo.svg',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Claudio-Fontes/iacmp' },
      { icon: 'linkedin', link: 'https://www.linkedin.com/in/claudio-me1o' },
    ],
    search: { provider: 'local' },
  },
});
