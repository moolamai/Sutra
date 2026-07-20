import { defineConfig } from "vitepress";

/**
 * VitePress chrome for the public Sutra docs site.
 * Markdown bodies under /reference/ are synced from repo docs/ — see OWNERSHIP.md.
 */
export default defineConfig({
  title: "Sutra",
  description:
    "Open cognitive infrastructure for sovereign, offline-first companions",
  cleanUrls: true,
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: "Overview", link: "/reference/overview" },
      { text: "Quickstart", link: "/src/quickstarts/implementor" },
      { text: "Architecture", link: "/reference/architecture/" },
      { text: "Protocol", link: "/reference/protocol/" },
      { text: "SDK", link: "/reference/sdk/" },
      { text: "API", link: "/api/" },
      {
        text: "Ownership",
        link: "https://github.com/moolamai/sutra/blob/main/docs-site/OWNERSHIP.md",
      },
    ],
    sidebar: {
      "/src/quickstarts/": [
        {
          text: "Quickstarts",
          items: [
            {
              text: "Implementor (install → turn → sync)",
              link: "/src/quickstarts/implementor",
            },
            {
              text: "Conformance (obligation CLI)",
              link: "/src/quickstarts/conformance",
            },
            {
              text: "Binding certification",
              link: "/src/quickstarts/binding-certification",
            },
            {
              text: "Stranger test",
              link: "/src/quickstarts/stranger-test",
            },
            {
              text: "Implementor (canonical)",
              link: "/reference/sdk/implementor-quickstart",
            },
            {
              text: "Conformance stub (canonical)",
              link: "/reference/sdk/conformance-stub-guide",
            },
            {
              text: "Binding cert (canonical)",
              link: "/reference/sdk/binding-certification-guide",
            },
          ],
        },
      ],
      "/api/": [
        {
          text: "API reference",
          items: [
            { text: "Index", link: "/api/" },
            {
              text: "Generated from dist/*.d.ts",
              link: "/api/",
            },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Start here",
          items: [{ text: "Overview", link: "/reference/overview" }],
        },
        {
          text: "Architecture",
          items: [{ text: "Architecture README", link: "/reference/architecture/" }],
        },
        {
          text: "Protocol",
          items: [
            { text: "Protocol README", link: "/reference/protocol/" },
            { text: "Metering", link: "/reference/protocol/METERING" },
            {
              text: "Harness stream semantics",
              link: "/reference/protocol/HARNESS-STREAM-SEMANTICS",
            },
            {
              text: "Degradation registry",
              link: "/reference/protocol/DEGRADATION-REGISTRY",
            },
            {
              text: "Version lockstep",
              link: "/reference/protocol/VERSION-LOCKSTEP",
            },
          ],
        },
        {
          text: "SDK",
          items: [
            { text: "SDK README", link: "/reference/sdk/" },
            { text: "Interfaces", link: "/reference/sdk/INTERFACES" },
            {
              text: "Implementor quickstart",
              link: "/reference/sdk/implementor-quickstart",
            },
            {
              text: "Conformance stub guide",
              link: "/reference/sdk/conformance-stub-guide",
            },
            {
              text: "Binding certification guide",
              link: "/reference/sdk/binding-certification-guide",
            },
            {
              text: "Conformance quickstart",
              link: "/reference/sdk/conformance-quickstart",
            },
            {
              text: "Publish checklist",
              link: "/reference/sdk/PUBLISH-CHECKLIST",
            },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/moolamai/sutra" },
    ],
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
    },
  },
});
