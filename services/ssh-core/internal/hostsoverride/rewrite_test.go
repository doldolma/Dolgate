package hostsoverride

import "testing"

func TestRewriteManagedBlockPreservesUnmanagedContent(t *testing.T) {
	input := "127.0.0.1 localhost\n# custom entry\n10.0.0.5 db.internal\n"

	output, changed := RewriteManagedBlock(input, []Entry{
		{Address: "127.0.0.2", Hostname: "b-2.kafka.internal"},
		{Address: "127.0.0.3", Hostname: "b-1.kafka.internal"},
	})

	if !changed {
		t.Fatalf("expected content to change")
	}

	expected := "127.0.0.1 localhost\n# custom entry\n10.0.0.5 db.internal\n# >>> dolssh managed dns overrides >>>\n127.0.0.3 b-1.kafka.internal\n127.0.0.2 b-2.kafka.internal\n# <<< dolssh managed dns overrides <<<\n"
	if output != expected {
		t.Fatalf("unexpected output:\n%s", output)
	}
}

func TestRewriteManagedBlockReplacesExistingManagedSections(t *testing.T) {
	input := "127.0.0.1 localhost\r\n# >>> dolssh managed dns overrides >>>\r\n127.0.0.2 old.example.com\r\n# <<< dolssh managed dns overrides <<<\r\n# extra\r\n# >>> dolssh managed dns overrides >>>\r\n127.0.0.3 duplicate.example.com\r\n"

	output, _ := RewriteManagedBlock(input, []Entry{
		{Address: "127.0.0.4", Hostname: "new.example.com"},
	})

	expected := "127.0.0.1 localhost\r\n# extra\r\n# >>> dolssh managed dns overrides >>>\r\n127.0.0.4 new.example.com\r\n# <<< dolssh managed dns overrides <<<\r\n"
	if output != expected {
		t.Fatalf("unexpected output:\n%s", output)
	}
}

func TestClearManagedBlockRemovesOnlyManagedSection(t *testing.T) {
	input := "# custom before\n# >>> dolssh managed dns overrides >>>\n127.0.0.2 broker.example.com\n# <<< dolssh managed dns overrides <<<\n# custom after\n"

	output, changed := ClearManagedBlock(input)

	if !changed {
		t.Fatalf("expected content to change")
	}
	expected := "# custom before\n# custom after\n"
	if output != expected {
		t.Fatalf("unexpected output:\n%s", output)
	}
}

func TestNormalizeEntriesDeduplicatesAndSorts(t *testing.T) {
	entries := normalizeEntries([]Entry{
		{Address: "127.0.0.2", Hostname: "B-2.kafka.internal"},
		{Address: "127.0.0.2", Hostname: "b-2.kafka.internal"},
		{Address: "127.0.0.3", Hostname: "b-1.kafka.internal"},
	})

	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Hostname != "b-1.kafka.internal" || entries[1].Hostname != "b-2.kafka.internal" {
		t.Fatalf("unexpected order: %#v", entries)
	}
}
