package com.atypical.koine.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * How to launch the Koine language server, mirroring the VS Code extension's
 * `koine.server.path` / `koine.server.args` settings:
 *
 * - [serverPath] blank → use the `koine` executable on `PATH` (`koine lsp`).
 * - [serverPath] = an absolute path to a published `koine` binary (invoked as `<path> lsp`).
 * - [serverPath] = `dotnet` with [serverArgs] = `["/abs/Koine.Cli.dll"]` to run a built DLL.
 *
 * The `KOINE_SERVER_PATH` environment variable overrides [serverPath] when set, so a
 * developer can point at a freshly built server without touching IDE settings.
 *
 * NOTE: a Settings UI panel (Configurable) is a follow-up; for now the state is editable
 * programmatically / via the env var. Defaults give the on-PATH `koine lsp` experience.
 */
@Service(Service.Level.APP)
@State(name = "KoineServerSettings", storages = [Storage("koine.xml")])
class KoineServerSettings : PersistentStateComponent<KoineServerSettings.State> {

    data class State(
        var serverPath: String = "",
        var serverArgs: MutableList<String> = mutableListOf(),
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    /** Resolved launcher: env override, then the stored path, then `koine` on PATH. */
    val resolvedPath: String
        get() = System.getenv("KOINE_SERVER_PATH")?.takeIf { it.isNotBlank() }
            ?: state.serverPath.takeIf { it.isNotBlank() }
            ?: "koine"

    val args: List<String> get() = state.serverArgs

    companion object {
        val instance: KoineServerSettings
            get() = ApplicationManager.getApplication().getService(KoineServerSettings::class.java)
    }
}
