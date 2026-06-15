parser grammar KoineParser;

options { tokenVocab=KoineLexer; }

// ============================================================================
// Koine parser. Produces a parse tree consumed by KoineModelBuilderVisitor,
// which builds the target-agnostic semantic model in Ast/.
// ============================================================================

// ---- Top level -------------------------------------------------------------

program        : contextDecl* EOF ;

contextDecl    : CONTEXT Identifier LBRACE contextMember* RBRACE ;

// A context holds types plus behavioral declarations (specs, services, policies).
contextMember  : typeDecl
               | specDecl
               | serviceDecl
               | policyDecl
               ;

typeDecl       : valueDecl
               | quantityDecl
               | entityDecl
               | aggregateDecl
               | enumDecl
               | eventDecl
               ;

// ---- Specifications, services, policies (R10) ------------------------------

// A named, reusable boolean specification over a target type.
specDecl       : SPEC Identifier ON typeName ASSIGN expression ;

// A stateless domain service with pure (or seam) operations.
serviceDecl    : SERVICE Identifier LBRACE operationDecl* RBRACE ;

operationDecl  : OPERATION Identifier LPAREN paramList? RPAREN COLON typeRef ( ASSIGN expression )? ;

// A policy: react to a domain event with a command on another aggregate (a seam).
policyDecl     : POLICY Identifier WHEN Identifier THEN policyReaction ;

policyReaction : typeName DOT softName ( LPAREN policyArgList? RPAREN )? ;

policyArgList  : policyArg ( COMMA policyArg )* ;

policyArg      : softName COLON expression ;

// ---- Type declarations -----------------------------------------------------

valueDecl      : VALUE Identifier LBRACE member* invariant* RBRACE ;

// A quantity: a value object combining a numeric amount with a unit (an enum),
// emitted with unit-checked arithmetic. Mirrors valueDecl's body.
quantityDecl   : QUANTITY Identifier LBRACE member* invariant* RBRACE ;

entityDecl     : ENTITY Identifier IDENTIFIED BY Identifier identityStrategy?
                 LBRACE member* invariant* statesDecl* commandDecl* factoryDecl* RBRACE ;

// How an identity is generated and typed (R11.1). Absent => the default Guid wrapper.
identityStrategy : AS ( GUID
                      | SEQUENCE
                      | NATURAL LPAREN typeName RPAREN ) ;

// ---- State machine (legal transitions of an enum-typed lifecycle field) -----

statesDecl     : STATES softName LBRACE stateRule* RBRACE ;

stateRule      : Identifier ( RARROW Identifier ( COMMA Identifier )* )? ( WHEN expression )? ;

// ---- Commands (state-changing operations on an entity) ---------------------

commandDecl    : COMMAND Identifier ( LPAREN paramList? RPAREN )? LBRACE commandStmt* RBRACE ;

paramList      : param ( COMMA param )* ;

param          : softName COLON typeRef ;

commandStmt    : requiresClause
               | transition
               | emitClause
               ;

requiresClause : REQUIRES expression StringLiteral? ;

transition     : softName RARROW expression ;                  // `status -> Placed`

emitClause     : EMIT Identifier ( LPAREN emitArgList? RPAREN )? ;   // `emit OrderPlaced(orderId: id)`

emitArgList    : emitArg ( COMMA emitArg )* ;

emitArg        : softName COLON expression ;

// ---- Factories (intention-revealing creation of an aggregate root) ----------

factoryDecl    : CREATE Identifier ( LPAREN paramList? RPAREN )? LBRACE factoryStmt* RBRACE ;

factoryStmt    : requiresClause
               | initialization
               | emitClause
               ;

initialization : softName LARROW expression ;                  // `total <- lines.sum(...)`

// `versioned` marks the root for optimistic concurrency (R11.4).
aggregateDecl  : AGGREGATE Identifier ROOT Identifier VERSIONED? LBRACE aggregateMember* RBRACE ;

// An aggregate holds its nested types, aggregate-scoped specifications, and an
// optional repository declaration (R11.3).
aggregateMember : typeDecl | specDecl | repositoryDecl ;

// ---- Repositories (R11.3) --------------------------------------------------

// At most one `operations:` clause, declared first, then any number of finders.
// (A second/misplaced clause is a syntax error rather than a silent last-wins.)
repositoryDecl   : REPOSITORY LBRACE operationsClause? finderDecl* RBRACE ;

// Which mutating operations the repository exposes: `operations: add, getById`.
operationsClause : OPERATIONS COLON Identifier ( COMMA Identifier )* ;

// A declarative finder: `find byCustomer(customer: CustomerId): List<Order>`.
finderDecl       : FIND Identifier LPAREN paramList? RPAREN COLON typeRef ;

// An enumeration. Members may carry associated constant data when the enum
// declares a signature: `enum Currency(symbol: String, decimals: Int) { EUR("€", 2) }`.
// Members are separated by whitespace or optional commas (both `A, B` and `A B`).
enumDecl       : ENUM Identifier ( LPAREN paramList? RPAREN )? LBRACE enumMember ( COMMA? enumMember )* COMMA? RBRACE ;

enumMember     : Identifier ( LPAREN ( expression ( COMMA expression )* )? RPAREN )? ;

// A domain event: an immutable record of something that happened. Fields only.
eventDecl      : EVENT Identifier LBRACE member* RBRACE ;

// ---- Members & invariants --------------------------------------------------

member         : softName COLON typeRef ( ASSIGN expression )? ;

// A type reference: `T`, `T?` (optional), `List<T>`, `Set<T>`, `Map<K,V>`.
typeRef        : typeName ( LT typeRef ( COMMA typeRef )? GT )? QUESTION? ;

// Soft keywords. A MEMBER NAME (declared, accessed via `.`, or a lambda
// parameter) may be (almost) any keyword — its position is unambiguous. A bare
// LEADING expression identifier additionally admits `when` (which only acts as
// the infix guard operator after a condExpr); `if/then/else` stay reserved
// there. A TYPE name is a declaration keyword. `matches`/`invariant` stay fully
// reserved (lexer mode / declaration ambiguity).
softName       : Identifier | declKeyword | WHEN | IF | THEN | ELSE ;
exprName       : Identifier | declKeyword | WHEN ;
typeName       : Identifier | declKeyword ;
declKeyword    : CONTEXT | VALUE | QUANTITY | ENTITY | AGGREGATE | ENUM | IDENTIFIED | BY | ROOT | COMMAND | REQUIRES | EVENT | EMIT | STATES | CREATE | SPEC | ON | SERVICE | OPERATION | POLICY | AS | NATURAL | SEQUENCE | GUID | VERSIONED | REPOSITORY | OPERATIONS | FIND ;

invariant      : INVARIANT expression StringLiteral? ;

// ---- Expression sublanguage (small, pure, no statements/IO) ----------------
// Precedence climbs from lowest (when-guard) to highest (postfix/primary).

expression     : guardExpr ;

guardExpr      : condExpr ( WHEN condExpr )? ;                  // `<expr> when <cond>`

condExpr       : IF condExpr THEN condExpr ELSE condExpr        // `if c then a else b`
               | coalesceExpr
               ;

coalesceExpr   : orExpr ( COALESCE orExpr )* ;                  // `nickname ?? name`

orExpr         : andExpr ( OR andExpr )* ;

andExpr        : equalityExpr ( AND equalityExpr )* ;

equalityExpr   : relationalExpr ( ( EQ | NEQ ) relationalExpr )* ;

relationalExpr : matchExpr ( ( LT | LE | GT | GE ) matchExpr )* ;

matchExpr      : additiveExpr ( MATCHES Regex )? ;             // `raw matches /.../`

additiveExpr   : multiplicativeExpr ( ( PLUS | MINUS ) multiplicativeExpr )* ;

multiplicativeExpr : unaryExpr ( ( STAR | SLASH ) unaryExpr )* ;

unaryExpr      : ( NOT | MINUS ) unaryExpr
               | postfixExpr
               ;

// member access (lines.isEmpty) and operation calls (lines.all(l => l.qty > 0)).
// The member/op name after `.` may be a soft keyword (e.g. `inner.value`).
postfixExpr    : primary ( DOT softName ( LPAREN argList? RPAREN )? )* ;

argList        : argument ( COMMA argument )* ;

argument       : lambda
               | expression
               ;

lambda         : softName ARROW expression ;                   // `l => l.quantity > 0`

primary        : literal
               | exprName
               | LPAREN expression RPAREN
               ;

literal        : DecimalLiteral
               | IntLiteral
               | StringLiteral
               | BoolLiteral
               ;
