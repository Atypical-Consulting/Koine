namespace Koine.Mcp.Tests;

/// <summary>
/// Unit tests for <see cref="KnowledgeStore"/>: the section scanner (including the empty-section
/// guard) and the centralized "unknown X" / listing messages shared by the tools and resources.
/// </summary>
public sealed class KnowledgeStoreTests
{
    [Fact]
    public void ReferenceSection_returns_null_for_an_empty_section()
    {
        // The `empty` marker is immediately followed by the next marker, so its body is blank.
        const string markdown = """
            <!-- topic: empty -->
            <!-- topic: next -->
            Some content here.
            """;

        KnowledgeStore.ReferenceSection(markdown, "empty").ShouldBeNull();
    }

    [Fact]
    public void ReferenceSection_returns_the_trimmed_body_of_a_populated_section()
    {
        const string markdown = """
            <!-- topic: first -->

            First section body.

            <!-- topic: second -->
            Second section body.
            """;

        KnowledgeStore.ReferenceSection(markdown, "first").ShouldBe("First section body.");
    }

    [Fact]
    public void ReferenceSection_returns_null_for_an_unknown_topic()
    {
        const string markdown = """
            <!-- topic: only -->
            Body.
            """;

        KnowledgeStore.ReferenceSection(markdown, "missing").ShouldBeNull();
    }

    [Fact]
    public void UnknownTopicMessage_names_the_bad_topic_and_lists_available_topics()
    {
        var message = KnowledgeStore.UnknownTopicMessage("does-not-exist");

        message.ShouldContain("Unknown topic");
        message.ShouldContain("does-not-exist");
        foreach (var topic in KnowledgeStore.ReferenceTopics)
        {
            message.ShouldContain(topic);
        }
    }

    [Fact]
    public void UnknownExampleMessage_names_the_bad_example_and_lists_available_examples()
    {
        var message = KnowledgeStore.UnknownExampleMessage("nope");

        message.ShouldContain("Unknown example");
        message.ShouldContain("nope");
        foreach (var name in KnowledgeStore.Examples.Keys)
        {
            message.ShouldContain(name);
        }
    }

    [Theory]
    [MemberData(nameof(ReferenceTopics))]
    public void Every_advertised_topic_resolves_to_a_non_empty_section(string slug)
    {
        var section = KnowledgeStore.ReferenceSection(slug);

        section.ShouldNotBeNull();
        string.IsNullOrWhiteSpace(section).ShouldBeFalse();
    }

    public static IEnumerable<object[]> ReferenceTopics() =>
        KnowledgeStore.ReferenceTopics.Select(topic => new object[] { topic });
}
