package com.atypical.koine.lsp

import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider

/**
 * Wires the Koine server into LSP4IJ. Declared by the `com.redhat.devtools.lsp4ij.server`
 * extension in plugin.xml. The default LanguageClientImpl/server interface are sufficient —
 * Koine speaks standard LSP, so rename, diagnostics, and code actions surface automatically
 * (the latter as Alt+Enter intentions / quick-fixes, the former as the inline-rename bubble).
 */
class KoineLspServerFactory : LanguageServerFactory {
    override fun createConnectionProvider(project: Project): StreamConnectionProvider =
        KoineServerConnectionProvider(project)
}
