package com.atypical.koine

import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

/**
 * The `.koi` file type — matches the extension used by the VS Code extension
 * (tooling/koine-textmate) and the `koine` CLI. Registered via plugin.xml; LSP4IJ's
 * languageMapping binds this language to the Koine language server.
 */
object KoineFileType : LanguageFileType(KoineLanguage) {
    override fun getName(): String = "Koine"
    override fun getDescription(): String = "Koine DDD language"
    override fun getDefaultExtension(): String = "koi"
    override fun getIcon(): Icon? = null
}
