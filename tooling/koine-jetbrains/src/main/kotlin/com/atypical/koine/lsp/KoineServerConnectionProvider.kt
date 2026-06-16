package com.atypical.koine.lsp

import com.atypical.koine.settings.KoineServerSettings
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.project.Project
import com.redhat.devtools.lsp4ij.server.OSProcessStreamConnectionProvider

/**
 * Spawns the Koine language server as an external process speaking LSP over stdio.
 * The command is `<server> [args...] lsp` — e.g. the default `koine lsp` (the `lsp`
 * verb is dispatched by src/Koine.Cli/Program.cs). LSP4IJ manages the process lifecycle.
 */
class KoineServerConnectionProvider(project: Project) : OSProcessStreamConnectionProvider() {
    init {
        val settings = KoineServerSettings.instance
        val command = buildList {
            add(settings.resolvedPath)
            addAll(settings.args)
            add("lsp")
        }
        val commandLine = GeneralCommandLine(command)
        project.basePath?.let { commandLine.setWorkDirectory(it) }
        super.setCommandLine(commandLine)
    }
}
