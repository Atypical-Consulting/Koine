import org.jetbrains.intellij.platform.gradle.TestFrameworkType

// Koine plugin for JetBrains Rider. It is a thin LSP *client*: it binds the `.koi`
// file type to the existing Koine language server (`koine lsp`, src/Koine.Cli) via the
// LSP4IJ community plugin, so rename / diagnostics / code actions flow from the .NET
// server and surface as Rider's Alt+Enter intentions and inline-rename bubble.

val riderVersion: String by project
val lsp4ijVersion: String by project
val kotlinVersion: String by project

plugins {
    kotlin("jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.16.0"
}

group = "com.atypical.koine"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // useInstaller = false: Rider plugins must build against the non-installer
        // distribution (intellij-platform-gradle-plugin issues #1852/#1903).
        rider(riderVersion, useInstaller = false)

        // LSP4IJ from the JetBrains Marketplace (plugin id 23257). It provides the LSP
        // client runtime; our plugin declares the server + language mapping against it.
        plugin("com.redhat.devtools.lsp4ij", lsp4ijVersion)

        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            // Rider 2024.3 == build 243; LSP4IJ's floor is 242.
            sinceBuild = "243"
            untilBuild = provider { null }
        }
    }
}

kotlin {
    jvmToolchain(21)
}
