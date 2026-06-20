---
title: "Keyword & operator index"
description: "Alphabetical index of Koine keywords and operators, linking to where each is defined."
---

An alphabetical index of Koine's keywords and operators, each linking to the section that defines it.

:::note
This index is populated as chapters are reformalized. Entries below cover the lexical structure
([§3](/Koine/reference/lexical-structure/)), value objects
([§5](/Koine/reference/value-objects/)), and expressions
([§9](/Koine/reference/expressions/)); the remaining construct chapters are added as they land.
:::

## Keywords

| Keyword | Kind | Defined in |
| --- | --- | --- |
| `invariant` | reserved | [§3.5.1](/Koine/reference/lexical-structure/#351-reserved-keywords), [§5.3](/Koine/reference/value-objects/#53-semantics) |
| `matches` | reserved | [§3.5.1](/Koine/reference/lexical-structure/#351-reserved-keywords), [§9.8](/Koine/reference/expressions/#98-pattern-matching) |
| `value` | soft (declaration) | [§5.2](/Koine/reference/value-objects/#52-syntax) |
| `quantity` | soft (declaration) | [§5.5](/Koine/reference/value-objects/#55-quantities) |
| `let` … `in` | soft (leading expression) | [§9.2](/Koine/reference/expressions/#92-syntax) |
| `if` / `then` / `else` | conditional expression | [§9.6](/Koine/reference/expressions/#96-conditionals) |
| `when` | guard operator | [§9.7](/Koine/reference/expressions/#97-guards) |

## Operators and punctuators

| Operator | Meaning | Defined in |
| --- | --- | --- |
| `=` | declaration default | [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators) |
| `->` | state effect (init / transition) | [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators) |
| `=>` | lambda arrow | [§9.9](/Koine/reference/expressions/#99-collection-operations) |
| `??` | coalesce | [§9.10](/Koine/reference/expressions/#910-optionality) |
| `+` `-` `*` `/` | arithmetic | [§9.4](/Koine/reference/expressions/#94-arithmetic) |
| `== != < <= > >=` | comparison | [§9.5](/Koine/reference/expressions/#95-comparison) |
| `&& \|\| !` | boolean logic | [§9.3](/Koine/reference/expressions/#93-logical-operators) |
| `matches /…/` | regex match | [§9.8](/Koine/reference/expressions/#98-pattern-matching) |
