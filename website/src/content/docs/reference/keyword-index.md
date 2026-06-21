---
title: "Keyword & operator index"
description: "Alphabetical index of Koine keywords and operators, linking to where each is defined."
---

An alphabetical index of Koine's keywords and operators, each linking to the section that defines it.
This index is complete and covers all construct chapters (§3–§18).

## Keywords

| Keyword | Kind | Defined in |
| --- | --- | --- |
| `@deprecated` | annotation | [§18.3.3](/Koine/reference/versioning/#1833-deprecated-semantics) |
| `@since` | annotation | [§18.3.2](/Koine/reference/versioning/#1832-since-ceiling-check-koi1501) |
| `acl` | soft (context map role) | [§17.3.2](/Koine/reference/context-maps-integration/#1732-the-seven-roles) |
| `aggregate` | soft (declaration) | [§7.2](/Koine/reference/aggregates/#72-syntax) |
| `anti-corruption-layer` | contextual (hyphenated role) | [§3.5.3](/Koine/reference/lexical-structure/#353-contextual-hyphenated-role-keywords), [§17.3.2](/Koine/reference/context-maps-integration/#1732-the-seven-roles) |
| `as` | soft (identity clause) | [§6.5](/Koine/reference/entities-and-identity/#65-identity-strategies) |
| `by` | soft (identity clause) | [§6.2](/Koine/reference/entities-and-identity/#62-syntax) |
| `command` | soft (declaration) | [§11.2](/Koine/reference/commands-events-state/#112-syntax) |
| `conformist` | contextual (hyphenated role) | [§3.5.3](/Koine/reference/lexical-structure/#353-contextual-hyphenated-role-keywords), [§17.3.2](/Koine/reference/context-maps-integration/#1732-the-seven-roles) |
| `context` | soft (declaration) | [§4.2.1](/Koine/reference/contexts-and-types/#421-the-context-block) |
| `contextmap` | soft (declaration) | [§17.2.1](/Koine/reference/context-maps-integration/#1721-context-map-declaration) |
| `create` | soft (factory declaration) | [§12.2](/Koine/reference/factories/#122-syntax) |
| `customer-supplier` | contextual (hyphenated role) | [§3.5.3](/Koine/reference/lexical-structure/#353-contextual-hyphenated-role-keywords), [§17.3.2](/Koine/reference/context-maps-integration/#1732-the-seven-roles) |
| `else` | conditional expression | [§9.6](/Koine/reference/expressions/#96-conditionals) |
| `emit` | soft (event emission) | [§11.5](/Koine/reference/commands-events-state/#115-domain-events) |
| `entity` | soft (declaration) | [§6.2](/Koine/reference/entities-and-identity/#62-syntax) |
| `enum` | soft (declaration) | [§8.2](/Koine/reference/enums/#82-syntax) |
| `event` | soft (declaration) | [§11.5](/Koine/reference/commands-events-state/#115-domain-events) |
| `find` | soft (repository finder) | [§14.3.2](/Koine/reference/repositories-concurrency/#1432-finder-validation-rules) |
| `from` | soft (read-model source) | [§15.2.2](/Koine/reference/application-cqrs/#1522-read-models) |
| `guid` | soft (identity strategy) | [§6.5.1](/Koine/reference/entities-and-identity/#651-default-guid) |
| `identified` | soft (identity clause) | [§6.2](/Koine/reference/entities-and-identity/#62-syntax) |
| `if` | conditional expression | [§9.6](/Koine/reference/expressions/#96-conditionals) |
| `import` | soft (module import) | [§16.2.1](/Koine/reference/multi-file-imports-modules/#1621-named-import) |
| `in` | soft (let binding) | [§9.2](/Koine/reference/expressions/#92-syntax) |
| `integration` | soft (integration event) | [§17.2.2](/Koine/reference/context-maps-integration/#1722-integration-event-declaration) |
| `invariant` | reserved | [§3.5.1](/Koine/reference/lexical-structure/#351-reserved-keywords), [§10.2](/Koine/reference/invariants/#102-syntax) |
| `let` | soft (leading expression) | [§9.2](/Koine/reference/expressions/#92-syntax) |
| `matches` | reserved | [§3.5.1](/Koine/reference/lexical-structure/#351-reserved-keywords), [§9.8](/Koine/reference/expressions/#98-pattern-matching) |
| `module` | soft (module declaration) | [§16.2.4](/Koine/reference/multi-file-imports-modules/#1624-module-declaration) |
| `natural` | soft (identity strategy) | [§6.5.2](/Koine/reference/entities-and-identity/#652-natural-string-as-naturalstring) |
| `on` | soft (policy trigger) | [§13.3.3](/Koine/reference/specs-services-policies/#1333-policy-semantics) |
| `open-host` | contextual (hyphenated role) | [§3.5.3](/Koine/reference/lexical-structure/#353-contextual-hyphenated-role-keywords), [§17.3.2](/Koine/reference/context-maps-integration/#1732-the-seven-roles) |
| `operation` | soft (service operation) | [§13.3.2](/Koine/reference/specs-services-policies/#1332-service-semantics) |
| `operations` | soft (repository operations block) | [§14.3.1](/Koine/reference/repositories-concurrency/#1431-the-operations-clause) |
| `partnership` | contextual (hyphenated role) | [§3.5.3](/Koine/reference/lexical-structure/#353-contextual-hyphenated-role-keywords), [§17.3.2](/Koine/reference/context-maps-integration/#1732-the-seven-roles) |
| `policy` | soft (declaration) | [§13.3.3](/Koine/reference/specs-services-policies/#1333-policy-semantics) |
| `publishes` | soft (publish declaration) | [§17.2.3](/Koine/reference/context-maps-integration/#1723-publish-and-subscribe-declarations) |
| `published-language` | contextual (hyphenated role) | [§3.5.3](/Koine/reference/lexical-structure/#353-contextual-hyphenated-role-keywords), [§17.3.2](/Koine/reference/context-maps-integration/#1732-the-seven-roles) |
| `quantity` | soft (declaration) | [§5.5](/Koine/reference/value-objects/#55-quantities) |
| `query` | soft (query object) | [§15.2.3](/Koine/reference/application-cqrs/#1523-query-objects) |
| `readmodel` | soft (declaration) | [§15.2.2](/Koine/reference/application-cqrs/#1522-read-models) |
| `repository` | soft (declaration) | [§14.2](/Koine/reference/repositories-concurrency/#142-syntax) |
| `requires` | soft (command precondition) | [§11.3.1](/Koine/reference/commands-events-state/#1131-preconditions-vs-invariants) |
| `result` | soft (command return type) | [§11.3.3](/Koine/reference/commands-events-state/#1133-returning-a-value) |
| `root` | soft (aggregate root marker) | [§7.2](/Koine/reference/aggregates/#72-syntax) |
| `sequence` | soft (identity strategy) | [§6.5.4](/Koine/reference/entities-and-identity/#654-sequence-as-sequence) |
| `service` | soft (declaration) | [§13.3.2](/Koine/reference/specs-services-policies/#1332-service-semantics) |
| `shared-kernel` | contextual (hyphenated role) | [§3.5.3](/Koine/reference/lexical-structure/#353-contextual-hyphenated-role-keywords), [§17.4](/Koine/reference/context-maps-integration/#174-shared-kernel) |
| `spec` | soft (declaration) | [§13.3.1](/Koine/reference/specs-services-policies/#1331-spec-semantics) |
| `states` | soft (state machine block) | [§11.6](/Koine/reference/commands-events-state/#116-state-machines) |
| `subscribes` | soft (subscribe declaration) | [§17.2.3](/Koine/reference/context-maps-integration/#1723-publish-and-subscribe-declarations) |
| `then` | conditional expression | [§9.6](/Koine/reference/expressions/#96-conditionals) |
| `usecase` | soft (declaration) | [§15.2.1](/Koine/reference/application-cqrs/#1521-application-services) |
| `value` | soft (declaration) | [§5.2](/Koine/reference/value-objects/#52-syntax) |
| `version` | soft (version stamp) | [§18.2](/Koine/reference/versioning/#182-syntax) |
| `versioned` | soft (aggregate modifier) | [§14.3.3](/Koine/reference/repositories-concurrency/#1433-versioned-aggregates) |
| `when` | guard operator | [§9.7](/Koine/reference/expressions/#97-guards) |

## Operators and punctuators

| Operator | Meaning | Defined in |
| --- | --- | --- |
| `!` | boolean NOT | [§9.3](/Koine/reference/expressions/#93-logical-operators) |
| `!=` | not-equal | [§9.5](/Koine/reference/expressions/#95-comparison) |
| `?` | optional type suffix | [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators) |
| `??` | null-coalesce | [§9.10](/Koine/reference/expressions/#910-optionality) |
| `*` | multiplication | [§9.4](/Koine/reference/expressions/#94-arithmetic) |
| `+` | addition | [§9.4](/Koine/reference/expressions/#94-arithmetic) |
| `-` | subtraction / unary negate | [§9.4](/Koine/reference/expressions/#94-arithmetic) |
| `/` | division | [§9.4](/Koine/reference/expressions/#94-arithmetic) |
| `<` | less-than | [§9.5](/Koine/reference/expressions/#95-comparison) |
| `<->` | bidirectional relation (context map) | [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators), [§17.2.1](/Koine/reference/context-maps-integration/#1721-context-map-declaration) |
| `<=` | less-than-or-equal | [§9.5](/Koine/reference/expressions/#95-comparison) |
| `=` | field default / declaration | [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators) |
| `==` | equality | [§9.5](/Koine/reference/expressions/#95-comparison) |
| `=>` | lambda arrow | [§9.9](/Koine/reference/expressions/#99-collection-operations) |
| `>` | greater-than | [§9.5](/Koine/reference/expressions/#95-comparison) |
| `>=` | greater-than-or-equal | [§9.5](/Koine/reference/expressions/#95-comparison) |
| `->` | state transition / init arrow | [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators), [§12.5](/Koine/reference/factories/#125-the---init-arrow) |
| `@` | annotation prefix | [§3.8](/Koine/reference/lexical-structure/#38-annotations) |
| `&&` | boolean AND | [§9.3](/Koine/reference/expressions/#93-logical-operators) |
| `\|\|` | boolean OR | [§9.3](/Koine/reference/expressions/#93-logical-operators) |
| `matches /…/` | regex pattern match | [§9.8](/Koine/reference/expressions/#98-pattern-matching), [§10.6](/Koine/reference/invariants/#106-regex-invariants-matches) |
