package store

import (
	"compress/gzip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"cs2-3d-demo-manager/internal/parser"
)

func makeSampleMatch(id, mapName string) *parser.ParsedMatch {
	return &parser.ParsedMatch{
		Metadata: parser.DemoMetadata{
			ID:          id,
			Filename:    id + ".dem",
			SourcePath:  "/tmp/" + id + ".dem",
			Format:      "dem",
			FileSize:    1024,
			MapName:     mapName,
			TickRate:    64,
			TotalTicks:  4000,
			DurationSec: 62.5,
			ScoreCT:     13,
			ScoreT:      9,
			RoundCount:  1,
			KillCount:   1,
			ParsedAt:    "2026-11-25T10:00:00Z",
			Status:      "ready",
		},
		Players: []parser.PlayerSummary{
			{Slot: 0, SteamID: "76561198000000001", Name: "Alpha", StartTeam: 3, Team: 3, Kills: 22, Deaths: 12, Assists: 4, Headshots: 11, Damage: 2100, ADR: 95.5, HSPct: 50},
			{Slot: 1, SteamID: "76561198000000002", Name: "Bravo", StartTeam: 2, Team: 2, Kills: 15, Deaths: 16, Assists: 2, Headshots: 5, Damage: 1500, ADR: 68.2, HSPct: 33.3},
		},
		Rounds: []parser.RoundSummary{
			{RoundNumber: 1, StartTick: 100, FreezeEndTick: 300, EndTick: 2500, OfficialEndTick: 2600, WinnerTeam: 3, WinReason: "CT Elimination", ScoreCT: 1, ScoreT: 0, KillCount: 1, FrameCount: 2},
		},
		Kills: []parser.KillEvent{
			{Round: 1, Tick: 900, KillerSlot: 0, KillerName: "Alpha", KillerTeam: 3, VictimSlot: 1, VictimName: "Bravo", VictimTeam: 2, Weapon: "AK-47", Headshot: true},
		},
		RoundData: map[int]*parser.RoundReplay{
			1: {
				DemoID:      id,
				RoundNumber: 1,
				TickRate:    64,
				Weapons:     []string{"AK-47"},
				Frames: []parser.Frame{
					{Tick: 100, Bomb: [5]float64{0, 0, 0, 1, 1}, Players: [][]float64{{1, 3, 10, 20, 30, 90, 0, 100, 100, 0, 0, 0, 0, 0, 1}}},
					{Tick: 101, Bomb: [5]float64{0, 0, 0, 1, 1}, Players: [][]float64{{1, 3, 12, 20, 30, 91, 0, 100, 100, 0, 0, 0, 0, 0, 1}}},
				},
			},
		},
	}
}

func TestStoreSaveSearchBookmarksAndDelete(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Create a dummy managed file to verify managed cleanup vs external preservation
	managedDemo := filepath.Join(dir, "demos", "m1.dem")
	if err := os.WriteFile(managedDemo, []byte("dummy"), 0644); err != nil {
		t.Fatal(err)
	}
	m1 := makeSampleMatch("m1", "de_nuke")
	m1.Metadata.SourcePath = managedDemo
	if err := s.SaveMatch(m1, true); err != nil {
		t.Fatalf("SaveMatch m1: %v", err)
	}

	m2 := makeSampleMatch("m2", "de_cache")
	if err := s.SaveMatch(m2, false); err != nil {
		t.Fatalf("SaveMatch m2: %v", err)
	}

	// Search by player name
	list, err := s.ListDemos("alpha", "de_nuke")
	if err != nil || len(list) != 1 || list[0].ID != "m1" {
		t.Fatalf("ListDemos(alpha, de_nuke) = %+v, err=%v", list, err)
	}

	// Bookmark persistence
	bm, err := s.CreateBookmark(Bookmark{
		DemoID:     "m1",
		Round:      1,
		Tick:       900,
		Label:      "Entry 1tap",
		Note:       "Clean peek",
		CameraMode: "pov",
		PlayerSlot: 0,
	})
	if err != nil {
		t.Fatalf("CreateBookmark: %v", err)
	}

	detail, err := s.GetDemo("m1")
	if err != nil {
		t.Fatalf("GetDemo: %v", err)
	}
	if len(detail.Bookmarks) != 1 || detail.Bookmarks[0].ID != bm.ID {
		t.Fatalf("bookmarks mismatch: %+v", detail.Bookmarks)
	}

	// Load gzipped round replay
	gz, err := s.LoadRoundReplayGzip("m1", 1)
	if err != nil {
		t.Fatalf("LoadRoundReplayGzip: %v", err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	var rr parser.RoundReplay
	if err := json.NewDecoder(zr).Decode(&rr); err != nil {
		t.Fatal(err)
	}
	zr.Close()
	if len(rr.Frames) != 2 || rr.Frames[0].Tick != 100 {
		t.Fatalf("unexpected round replay frames: %+v", rr.Frames)
	}

	if err := s.DeleteBookmark("m1", bm.ID); err != nil {
		t.Fatalf("DeleteBookmark: %v", err)
	}

	// Delete m1 -> removes managedDemo + cache
	if err := s.DeleteDemo("m1"); err != nil {
		t.Fatalf("DeleteDemo: %v", err)
	}
	if _, err := os.Stat(managedDemo); !os.IsNotExist(err) {
		t.Fatalf("expected managed demo to be deleted")
	}
	if _, err := s.GetDemo("m1"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}
}
