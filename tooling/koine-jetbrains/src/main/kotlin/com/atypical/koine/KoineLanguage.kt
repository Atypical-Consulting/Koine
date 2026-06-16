package com.atypical.koine

import com.intellij.lang.Language

/**
 * The Koine language. Registered only so a [com.intellij.openapi.fileTypes.LanguageFileType]
 * can bind `.koi` files to it and LSP4IJ can map that language to the Koine server. All real
 * language intelligence lives in the LSP server, not in PSI.
 */
object KoineLanguage : Language("Koine")
