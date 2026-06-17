// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

import koineGrammar from './src/grammars/koine.tmLanguage.json' with { type: 'json' };

// Register the repo's TextMate grammar so ```koine fenced blocks get real syntax
// highlighting (keywords, types, invariants, regex literals, …).
const koineLang = {
	...koineGrammar,
	name: 'koine',
	scopeName: 'source.koine',
	aliases: ['koi'],
};

// https://astro.build/config
export default defineConfig({
	// Project pages site for the Atypical-Consulting/Koine repository.
	site: 'https://atypical-consulting.github.io',
	base: '/Koine/',
	integrations: [
		starlight({
			title: 'Koine',
			description:
				'Koine is a domain-specific language for Domain-Driven Design: write the ubiquitous language once in .koi files and generate idiomatic C#.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/Atypical-Consulting/Koine' },
			],
			expressiveCode: {
				shiki: { langs: [koineLang] },
			},
			// Light blueprint brand pass over the docs (accent + display/mono fonts), kept
			// separate from Starlight's body readability. See src/styles/brand.css.
			customCss: ['./src/styles/brand.css'],
			editLink: {
				baseUrl: 'https://github.com/Atypical-Consulting/Koine/edit/main/website/',
			},
			sidebar: [
				{
					// Link out to the custom (non-Starlight) Playground page.
					label: '▸ Playground',
					link: '/playground/',
				},
				{
					label: 'Start here',
					items: [
						{ label: 'What is Koine?', slug: 'start/what-is-koine' },
						{ label: 'Installation', slug: 'start/installation' },
						{ label: 'Your first model', slug: 'start/your-first-model' },
						{ label: 'Reading the generated C#', slug: 'start/reading-the-output' },
					],
				},
				{
					label: 'Tutorials',
					items: [
						{ label: '1 · Values & invariants', slug: 'tutorials/values-and-invariants' },
						{ label: '2 · Entities & aggregates', slug: 'tutorials/entities-and-aggregates' },
						{ label: '3 · Commands, events & state', slug: 'tutorials/commands-events-state' },
						{ label: '4 · The application layer', slug: 'tutorials/application-layer' },
						{ label: '5 · Many bounded contexts', slug: 'tutorials/multiple-contexts' },
						{ label: '6 · Evolving a model', slug: 'tutorials/evolving-a-model' },
					],
				},
				{
					label: 'Language reference',
					items: [
						{ label: 'Overview', slug: 'reference/overview' },
						{ label: 'Contexts & types', slug: 'reference/contexts-and-types' },
						{ label: 'Value objects', slug: 'reference/value-objects' },
						{ label: 'Entities & identity', slug: 'reference/entities-and-identity' },
						{ label: 'Aggregates', slug: 'reference/aggregates' },
						{ label: 'Enums', slug: 'reference/enums' },
						{ label: 'Expressions', slug: 'reference/expressions' },
						{ label: 'Invariants', slug: 'reference/invariants' },
						{ label: 'Commands, events & state machines', slug: 'reference/commands-events-state' },
						{ label: 'Factories', slug: 'reference/factories' },
						{ label: 'Specs, services & policies', slug: 'reference/specs-services-policies' },
						{ label: 'Repositories & concurrency', slug: 'reference/repositories-concurrency' },
						{ label: 'Application layer & CQRS', slug: 'reference/application-cqrs' },
						{ label: 'Multi-file, imports & modules', slug: 'reference/multi-file-imports-modules' },
						{ label: 'Context maps & integration', slug: 'reference/context-maps-integration' },
						{ label: 'Versioning & evolution', slug: 'reference/versioning' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Feature catalogue (R1–R17)', slug: 'guides/feature-catalogue' },
						{ label: 'CLI reference', slug: 'guides/cli' },
						{ label: 'Architecture', slug: 'guides/architecture' },
						{ label: 'Editor tooling', slug: 'guides/editor-tooling' },
						{ label: 'Roadmap', slug: 'guides/roadmap' },
					],
				},
			],
		}),
	],
});
