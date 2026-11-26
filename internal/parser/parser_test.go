package parser

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenDemoStreamRejectsInvalidFile(t *testing.T) {
	tmp := t.TempDir()
	bad := filepath.Join(tmp, "bad.dem")
	if err := os.WriteFile(bad, []byte("not a valid cs2 demo file header"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := openDemoStream(bad); err == nil {
		t.Fatalf("expected error for invalid demo header")
	}
}

func TestParseRealDemosIfPresent(t *testing.T) {
	cases := []struct {
		name    string
		path    string
		wantMap string
	}{
		{
			name:    "cache_bz2",
			path:    os.Getenv("CS2_TEST_CACHE_DEMO"),
			wantMap: "de_cache",
		},
		{
			name:    "nuke",
			path:    os.Getenv("CS2_TEST_NUKE_DEMO"),
			wantMap: "de_nuke",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.path == "" {
				t.Skip("set the corresponding CS2_TEST_*_DEMO variable to enable this test")
			}
			m, err := ParseDemo("test-"+tc.name, tc.path)
			if err != nil {
				t.Fatalf("ParseDemo failed: %v", err)
			}
			t.Logf("map=%s format=%s rate=%.1f score=%d-%d rounds=%d players=%d kills=%d dur=%.1fs",
				m.Metadata.MapName, m.Metadata.Format, m.Metadata.TickRate,
				m.Metadata.ScoreCT, m.Metadata.ScoreT, m.Metadata.RoundCount,
				len(m.Players), m.Metadata.KillCount, m.Metadata.DurationSec)
			if tc.wantMap != "" && m.Metadata.MapName != tc.wantMap {
				t.Fatalf("map=%q want %q", m.Metadata.MapName, tc.wantMap)
			}
			if m.Metadata.RoundCount < 1 {
				t.Fatalf("expected at least 1 round, got %d", m.Metadata.RoundCount)
			}
			if len(m.Players) < 2 {
				t.Fatalf("expected players in roster, got %d", len(m.Players))
			}
			r1 := m.RoundData[1]
			if r1 == nil || len(r1.Frames) == 0 {
				t.Fatalf("expected round 1 frames")
			}
			t.Logf("round 1: frames=%d weapons=%d kills=%d shots=%d smokes=%d grenades=%d infernos=%d bombEvents=%d roundTime=%ds",
				len(r1.Frames), len(r1.Weapons), len(r1.Kills), len(r1.Shots), len(r1.Smokes), len(r1.Grenades), len(r1.Infernos), len(r1.BombEvents), r1.Summary.RoundTimeSec)
			if r1.Summary.RoundTimeSec <= 0 {
				t.Fatalf("expected positive RoundTimeSec")
			}
			if len(r1.Frames[0].Players) > 0 && len(r1.Frames[0].Players[0]) < 23 {
				t.Fatalf("expected 23-element player tuple, got %d", len(r1.Frames[0].Players[0]))
			}
			totalGrenades, totalInfernos := 0, 0
			for _, rr := range m.RoundData {
				totalGrenades += len(rr.Grenades)
				totalInfernos += len(rr.Infernos)
			}
			t.Logf("match totals: grenades=%d infernos=%d", totalGrenades, totalInfernos)
			if totalGrenades == 0 {
				t.Fatalf("expected non-zero grenades across full real match")
			}
		})
	}
}
