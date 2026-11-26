package store

import (
	"bytes"
	"compress/gzip"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cs2-3d-demo-manager/internal/parser"
	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

type Bookmark struct {
	ID         string `json:"id"`
	DemoID     string `json:"demo_id"`
	Round      int    `json:"round_number"`
	Tick       int    `json:"tick"`
	Label      string `json:"label"`
	Note       string `json:"note"`
	CameraMode string `json:"camera_mode"`
	PlayerSlot int    `json:"player_slot"`
	CreatedAt  string `json:"created_at"`
}

type DemoListItem struct {
	parser.DemoMetadata
	PlayerNames []string `json:"player_names"`
}

type DemoDetail struct {
	Metadata  parser.DemoMetadata    `json:"metadata"`
	Players   []parser.PlayerSummary `json:"players"`
	Rounds    []parser.RoundSummary  `json:"rounds"`
	Kills     []parser.KillEvent     `json:"kills"`
	Bookmarks []Bookmark             `json:"bookmarks"`
}

type Store struct {
	db      *sql.DB
	dataDir string
}

func Open(dataDir string) (*Store, error) {
	for _, sub := range []string{"", "demos", "cache", "assets/maps", "assets/players", "assets/radars"} {
		if err := os.MkdirAll(filepath.Join(dataDir, sub), 0755); err != nil {
			return nil, fmt.Errorf("mkdir %s: %w", sub, err)
		}
	}
	dbPath := filepath.Join(dataDir, "demos.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db, dataDir: dataDir}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) DataDir() string {
	return s.dataDir
}

func (s *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS demos (
	id TEXT PRIMARY KEY,
	filename TEXT NOT NULL,
	source_path TEXT NOT NULL,
	managed_file INTEGER NOT NULL DEFAULT 0,
	format TEXT NOT NULL,
	file_size INTEGER NOT NULL,
	map_name TEXT NOT NULL,
	tick_rate REAL NOT NULL,
	total_ticks INTEGER NOT NULL,
	duration_sec REAL NOT NULL,
	score_ct INTEGER NOT NULL,
	score_t INTEGER NOT NULL,
	round_count INTEGER NOT NULL,
	kill_count INTEGER NOT NULL,
	parsed_at TEXT NOT NULL,
	status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_players (
	demo_id TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
	slot INTEGER NOT NULL,
	steam_id TEXT NOT NULL,
	name TEXT NOT NULL,
	start_team INTEGER NOT NULL,
	team INTEGER NOT NULL,
	kills INTEGER NOT NULL,
	deaths INTEGER NOT NULL,
	assists INTEGER NOT NULL,
	headshots INTEGER NOT NULL,
	damage INTEGER NOT NULL,
	adr REAL NOT NULL,
	hs_pct REAL NOT NULL,
	rank_old INTEGER NOT NULL DEFAULT 0,
	rank_new INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (demo_id, slot)
);

CREATE TABLE IF NOT EXISTS demo_rounds (
	demo_id TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
	round_number INTEGER NOT NULL,
	start_tick INTEGER NOT NULL,
	freeze_end_tick INTEGER NOT NULL,
	end_tick INTEGER NOT NULL,
	official_end_tick INTEGER NOT NULL,
	winner_team INTEGER NOT NULL,
	win_reason TEXT NOT NULL,
	score_ct INTEGER NOT NULL,
	score_t INTEGER NOT NULL,
	kill_count INTEGER NOT NULL,
	bomb_planted INTEGER NOT NULL,
	bomb_site TEXT NOT NULL DEFAULT '',
	frame_count INTEGER NOT NULL,
	round_time_sec INTEGER NOT NULL DEFAULT 115,
	freeze_time_sec INTEGER NOT NULL DEFAULT 15,
	bomb_time_sec INTEGER NOT NULL DEFAULT 40,
	PRIMARY KEY (demo_id, round_number)
);

CREATE TABLE IF NOT EXISTS demo_kills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	demo_id TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
	round_number INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	killer_slot INTEGER NOT NULL,
	killer_name TEXT NOT NULL,
	killer_team INTEGER NOT NULL,
	victim_slot INTEGER NOT NULL,
	victim_name TEXT NOT NULL,
	victim_team INTEGER NOT NULL,
	assister_slot INTEGER NOT NULL,
	assister_name TEXT NOT NULL DEFAULT '',
	assister_team INTEGER NOT NULL DEFAULT 0,
	assisted_flash INTEGER NOT NULL DEFAULT 0,
	weapon TEXT NOT NULL,
	headshot INTEGER NOT NULL,
	wallbang INTEGER NOT NULL,
	through_smoke INTEGER NOT NULL,
	attacker_blind INTEGER NOT NULL,
	no_scope INTEGER NOT NULL,
	killer_x REAL NOT NULL,
	killer_y REAL NOT NULL,
	killer_z REAL NOT NULL,
	victim_x REAL NOT NULL,
	victim_y REAL NOT NULL,
	victim_z REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_bookmarks (
	id TEXT PRIMARY KEY,
	demo_id TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
	round_number INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	label TEXT NOT NULL,
	note TEXT NOT NULL DEFAULT '',
	camera_mode TEXT NOT NULL DEFAULT 'pov',
	player_slot INTEGER NOT NULL DEFAULT -1,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS map_asset_dirs (
	path TEXT PRIMARY KEY,
	added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demos_map ON demos(map_name);
CREATE INDEX IF NOT EXISTS idx_demo_players_name ON demo_players(name);
CREATE INDEX IF NOT EXISTS idx_demo_kills_demo_round ON demo_kills(demo_id, round_number);
CREATE INDEX IF NOT EXISTS idx_demo_bookmarks_demo ON demo_bookmarks(demo_id);
`
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}
	// Idempotent column migrations for pre-existing databases
	alters := []string{
		`ALTER TABLE demo_kills ADD COLUMN assister_team INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE demo_kills ADD COLUMN assisted_flash INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE demo_rounds ADD COLUMN round_time_sec INTEGER NOT NULL DEFAULT 115`,
		`ALTER TABLE demo_rounds ADD COLUMN freeze_time_sec INTEGER NOT NULL DEFAULT 15`,
		`ALTER TABLE demo_rounds ADD COLUMN bomb_time_sec INTEGER NOT NULL DEFAULT 40`,
	}
	for _, stmt := range alters {
		_, _ = s.db.Exec(stmt)
	}
	return nil
}

func (s *Store) roundCacheDir(demoID string) string {
	return filepath.Join(s.dataDir, "cache", demoID)
}

func (s *Store) roundCacheFile(demoID string, roundNum int) string {
	return filepath.Join(s.roundCacheDir(demoID), fmt.Sprintf("round_%d.json.gz", roundNum))
}

func (s *Store) SaveMatch(match *parser.ParsedMatch, managed bool) error {
	if match == nil {
		return errors.New("nil match")
	}
	cacheDir := s.roundCacheDir(match.Metadata.ID)
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return err
	}
	for roundNum, replay := range match.RoundData {
		var buf bytes.Buffer
		zw, err := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
		if err != nil {
			return err
		}
		if err := json.NewEncoder(zw).Encode(replay); err != nil {
			zw.Close()
			return err
		}
		if err := zw.Close(); err != nil {
			return err
		}
		if err := os.WriteFile(s.roundCacheFile(match.Metadata.ID, roundNum), buf.Bytes(), 0644); err != nil {
			return err
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	managedInt := 0
	if managed {
		managedInt = 1
	}
	m := match.Metadata
	if _, err := tx.Exec(`
		INSERT OR REPLACE INTO demos (
			id, filename, source_path, managed_file, format, file_size, map_name,
			tick_rate, total_ticks, duration_sec, score_ct, score_t, round_count,
			kill_count, parsed_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.Filename, m.SourcePath, managedInt, m.Format, m.FileSize, m.MapName,
		m.TickRate, m.TotalTicks, m.DurationSec, m.ScoreCT, m.ScoreT, m.RoundCount,
		m.KillCount, m.ParsedAt, m.Status,
	); err != nil {
		return err
	}

	if _, err := tx.Exec(`DELETE FROM demo_players WHERE demo_id = ?`, m.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM demo_rounds WHERE demo_id = ?`, m.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM demo_kills WHERE demo_id = ?`, m.ID); err != nil {
		return err
	}

	for _, p := range match.Players {
		if _, err := tx.Exec(`
			INSERT INTO demo_players (
				demo_id, slot, steam_id, name, start_team, team, kills, deaths,
				assists, headshots, damage, adr, hs_pct, rank_old, rank_new
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			m.ID, p.Slot, p.SteamID, p.Name, p.StartTeam, p.Team, p.Kills, p.Deaths,
			p.Assists, p.Headshots, p.Damage, p.ADR, p.HSPct, p.RankOld, p.RankNew,
		); err != nil {
			return err
		}
	}

	for _, r := range match.Rounds {
		planted := 0
		if r.BombPlanted {
			planted = 1
		}
		rtSec := r.RoundTimeSec
		if rtSec <= 0 {
			rtSec = 115
		}
		ftSec := r.FreezeTimeSec
		if ftSec < 0 {
			ftSec = 15
		}
		btSec := r.BombTimeSec
		if btSec <= 0 {
			btSec = 40
		}
		if _, err := tx.Exec(`
			INSERT INTO demo_rounds (
				demo_id, round_number, start_tick, freeze_end_tick, end_tick, official_end_tick,
				winner_team, win_reason, score_ct, score_t, kill_count, bomb_planted, bomb_site, frame_count,
				round_time_sec, freeze_time_sec, bomb_time_sec
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			m.ID, r.RoundNumber, r.StartTick, r.FreezeEndTick, r.EndTick, r.OfficialEndTick,
			r.WinnerTeam, r.WinReason, r.ScoreCT, r.ScoreT, r.KillCount, planted, r.BombSite, r.FrameCount,
			rtSec, ftSec, btSec,
		); err != nil {
			return err
		}
	}

	for _, k := range match.Kills {
		b2i := func(v bool) int {
			if v {
				return 1
			}
			return 0
		}
		if _, err := tx.Exec(`
			INSERT INTO demo_kills (
				demo_id, round_number, tick, killer_slot, killer_name, killer_team,
				victim_slot, victim_name, victim_team, assister_slot, assister_name,
				assister_team, assisted_flash,
				weapon, headshot, wallbang, through_smoke, attacker_blind, no_scope,
				killer_x, killer_y, killer_z, victim_x, victim_y, victim_z
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			m.ID, k.Round, k.Tick, k.KillerSlot, k.KillerName, k.KillerTeam,
			k.VictimSlot, k.VictimName, k.VictimTeam, k.AssisterSlot, k.AssisterName,
			k.AssisterTeam, b2i(k.AssistedFlash),
			k.Weapon, b2i(k.Headshot), b2i(k.Wallbang), b2i(k.ThroughSmoke), b2i(k.AttackerBlind), b2i(k.NoScope),
			k.KillerPos[0], k.KillerPos[1], k.KillerPos[2], k.VictimPos[0], k.VictimPos[1], k.VictimPos[2],
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *Store) ListDemos(query string, mapFilter string) ([]DemoListItem, error) {
	q := strings.TrimSpace(strings.ToLower(query))
	mf := strings.TrimSpace(strings.ToLower(mapFilter))

	var conds []string
	var args []any
	if mf != "" && mf != "all" {
		conds = append(conds, "LOWER(d.map_name) = ?")
		args = append(args, mf)
	}
	if q != "" {
		like := "%" + q + "%"
		conds = append(conds, `(
			LOWER(d.filename) LIKE ? OR
			LOWER(d.map_name) LIKE ? OR
			LOWER(d.id) LIKE ? OR
			EXISTS (SELECT 1 FROM demo_players dp WHERE dp.demo_id = d.id AND LOWER(dp.name) LIKE ?)
		)`)
		args = append(args, like, like, like, like)
	}

	sqlQuery := `
		SELECT d.id, d.filename, d.source_path, d.format, d.file_size, d.map_name,
		       d.tick_rate, d.total_ticks, d.duration_sec, d.score_ct, d.score_t,
		       d.round_count, d.kill_count, d.parsed_at, d.status
		FROM demos d
	`
	if len(conds) > 0 {
		sqlQuery += " WHERE " + strings.Join(conds, " AND ")
	}
	sqlQuery += " ORDER BY d.parsed_at DESC, d.id DESC"

	rows, err := s.db.Query(sqlQuery, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []DemoListItem
	for rows.Next() {
		var it DemoListItem
		if err := rows.Scan(
			&it.ID, &it.Filename, &it.SourcePath, &it.Format, &it.FileSize, &it.MapName,
			&it.TickRate, &it.TotalTicks, &it.DurationSec, &it.ScoreCT, &it.ScoreT,
			&it.RoundCount, &it.KillCount, &it.ParsedAt, &it.Status,
		); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range items {
		pRows, err := s.db.Query(`SELECT name FROM demo_players WHERE demo_id = ? ORDER BY start_team DESC, kills DESC`, items[i].ID)
		if err != nil {
			return nil, err
		}
		for pRows.Next() {
			var name string
			if err := pRows.Scan(&name); err == nil {
				items[i].PlayerNames = append(items[i].PlayerNames, name)
			}
		}
		pRows.Close()
	}
	return items, nil
}

func (s *Store) FindBySourcePath(sourcePath string) (*parser.DemoMetadata, error) {
	var m parser.DemoMetadata
	err := s.db.QueryRow(`
		SELECT id, filename, source_path, format, file_size, map_name,
		       tick_rate, total_ticks, duration_sec, score_ct, score_t,
		       round_count, kill_count, parsed_at, status
		FROM demos WHERE source_path = ? LIMIT 1
	`, sourcePath).Scan(
		&m.ID, &m.Filename, &m.SourcePath, &m.Format, &m.FileSize, &m.MapName,
		&m.TickRate, &m.TotalTicks, &m.DurationSec, &m.ScoreCT, &m.ScoreT,
		&m.RoundCount, &m.KillCount, &m.ParsedAt, &m.Status,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) GetDemo(id string) (*DemoDetail, error) {
	var m parser.DemoMetadata
	err := s.db.QueryRow(`
		SELECT id, filename, source_path, format, file_size, map_name,
		       tick_rate, total_ticks, duration_sec, score_ct, score_t,
		       round_count, kill_count, parsed_at, status
		FROM demos WHERE id = ?
	`, id).Scan(
		&m.ID, &m.Filename, &m.SourcePath, &m.Format, &m.FileSize, &m.MapName,
		&m.TickRate, &m.TotalTicks, &m.DurationSec, &m.ScoreCT, &m.ScoreT,
		&m.RoundCount, &m.KillCount, &m.ParsedAt, &m.Status,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	detail := &DemoDetail{Metadata: m}

	pRows, err := s.db.Query(`
		SELECT slot, steam_id, name, start_team, team, kills, deaths, assists,
		       headshots, damage, adr, hs_pct, rank_old, rank_new
		FROM demo_players WHERE demo_id = ?
		ORDER BY start_team DESC, kills DESC, slot ASC
	`, id)
	if err != nil {
		return nil, err
	}
	for pRows.Next() {
		var p parser.PlayerSummary
		if err := pRows.Scan(
			&p.Slot, &p.SteamID, &p.Name, &p.StartTeam, &p.Team, &p.Kills, &p.Deaths,
			&p.Assists, &p.Headshots, &p.Damage, &p.ADR, &p.HSPct, &p.RankOld, &p.RankNew,
		); err != nil {
			pRows.Close()
			return nil, err
		}
		detail.Players = append(detail.Players, p)
	}
	pRows.Close()

	rRows, err := s.db.Query(`
		SELECT round_number, start_tick, freeze_end_tick, end_tick, official_end_tick,
		       winner_team, win_reason, score_ct, score_t, kill_count, bomb_planted, bomb_site, frame_count,
		       round_time_sec, freeze_time_sec, bomb_time_sec
		FROM demo_rounds WHERE demo_id = ? ORDER BY round_number ASC
	`, id)
	if err != nil {
		return nil, err
	}
	for rRows.Next() {
		var r parser.RoundSummary
		var planted int
		if err := rRows.Scan(
			&r.RoundNumber, &r.StartTick, &r.FreezeEndTick, &r.EndTick, &r.OfficialEndTick,
			&r.WinnerTeam, &r.WinReason, &r.ScoreCT, &r.ScoreT, &r.KillCount, &planted, &r.BombSite, &r.FrameCount,
			&r.RoundTimeSec, &r.FreezeTimeSec, &r.BombTimeSec,
		); err != nil {
			rRows.Close()
			return nil, err
		}
		r.BombPlanted = planted != 0
		detail.Rounds = append(detail.Rounds, r)
	}
	rRows.Close()

	kRows, err := s.db.Query(`
		SELECT round_number, tick, killer_slot, killer_name, killer_team,
		       victim_slot, victim_name, victim_team, assister_slot, assister_name,
		       assister_team, assisted_flash,
		       weapon, headshot, wallbang, through_smoke, attacker_blind, no_scope,
		       killer_x, killer_y, killer_z, victim_x, victim_y, victim_z
		FROM demo_kills WHERE demo_id = ? ORDER BY round_number ASC, tick ASC, id ASC
	`, id)
	if err != nil {
		return nil, err
	}
	for kRows.Next() {
		var k parser.KillEvent
		var af, hs, wb, smk, bl, ns int
		if err := kRows.Scan(
			&k.Round, &k.Tick, &k.KillerSlot, &k.KillerName, &k.KillerTeam,
			&k.VictimSlot, &k.VictimName, &k.VictimTeam, &k.AssisterSlot, &k.AssisterName,
			&k.AssisterTeam, &af,
			&k.Weapon, &hs, &wb, &smk, &bl, &ns,
			&k.KillerPos[0], &k.KillerPos[1], &k.KillerPos[2],
			&k.VictimPos[0], &k.VictimPos[1], &k.VictimPos[2],
		); err != nil {
			kRows.Close()
			return nil, err
		}
		k.AssistedFlash = af != 0
		k.Headshot = hs != 0
		k.Wallbang = wb != 0
		k.ThroughSmoke = smk != 0
		k.AttackerBlind = bl != 0
		k.NoScope = ns != 0
		detail.Kills = append(detail.Kills, k)
	}
	kRows.Close()

	bms, err := s.ListBookmarks(id)
	if err != nil {
		return nil, err
	}
	detail.Bookmarks = bms
	return detail, nil
}

func (s *Store) LoadRoundReplayGzip(demoID string, roundNum int) ([]byte, error) {
	path := s.roundCacheFile(demoID, roundNum)
	data, err := os.ReadFile(path)
	if err == nil {
		// Check schema version; if outdated and source_path exists on disk, transparently re-parse once
		if zr, zErr := gzip.NewReader(bytes.NewReader(data)); zErr == nil {
			var header struct {
				SchemaVersion int `json:"v"`
			}
			_ = json.NewDecoder(zr).Decode(&header)
			zr.Close()
			if header.SchemaVersion >= parser.CurrentReplaySchemaVersion {
				return data, nil
			}
			if detail, gErr := s.GetDemo(demoID); gErr == nil && detail.Metadata.SourcePath != "" {
				if _, stErr := os.Stat(detail.Metadata.SourcePath); stErr == nil {
					if match, pErr := parser.ParseDemo(demoID, detail.Metadata.SourcePath); pErr == nil {
						var managed int
						_ = s.db.QueryRow(`SELECT managed_file FROM demos WHERE id = ?`, demoID).Scan(&managed)
						if sErr := s.SaveMatch(match, managed != 0); sErr == nil {
							if fresh, rErr := os.ReadFile(path); rErr == nil {
								return fresh, nil
							}
						}
					}
				}
			}
		}
		return data, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	// If missing from cache, check if demo exists and lazily re-parse from source_path
	detail, gErr := s.GetDemo(demoID)
	if gErr != nil {
		return nil, gErr
	}
	if detail.Metadata.SourcePath == "" {
		return nil, ErrNotFound
	}
	match, pErr := parser.ParseDemo(demoID, detail.Metadata.SourcePath)
	if pErr != nil {
		return nil, pErr
	}
	var managed int
	_ = s.db.QueryRow(`SELECT managed_file FROM demos WHERE id = ?`, demoID).Scan(&managed)
	if sErr := s.SaveMatch(match, managed != 0); sErr != nil {
		return nil, sErr
	}
	data, err = os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return data, err
}

func (s *Store) DeleteDemo(id string) error {
	var sourcePath string
	var managed int
	err := s.db.QueryRow(`SELECT source_path, managed_file FROM demos WHERE id = ?`, id).Scan(&sourcePath, &managed)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}

	if _, err := s.db.Exec(`DELETE FROM demos WHERE id = ?`, id); err != nil {
		return err
	}
	_ = os.RemoveAll(s.roundCacheDir(id))
	// Only remove managed uploaded files inside data/demos/; never touch external files!
	if managed != 0 && sourcePath != "" {
		demosRoot := filepath.Clean(filepath.Join(s.dataDir, "demos")) + string(os.PathSeparator)
		cleanSource := filepath.Clean(sourcePath)
		if strings.HasPrefix(cleanSource, demosRoot) {
			_ = os.Remove(cleanSource)
		}
	}
	return nil
}

func (s *Store) ListBookmarks(demoID string) ([]Bookmark, error) {
	rows, err := s.db.Query(`
		SELECT id, demo_id, round_number, tick, label, note, camera_mode, player_slot, created_at
		FROM demo_bookmarks WHERE demo_id = ? ORDER BY round_number ASC, tick ASC, created_at ASC
	`, demoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Bookmark, 0)
	for rows.Next() {
		var b Bookmark
		if err := rows.Scan(&b.ID, &b.DemoID, &b.Round, &b.Tick, &b.Label, &b.Note, &b.CameraMode, &b.PlayerSlot, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) CreateBookmark(b Bookmark) (Bookmark, error) {
	if b.DemoID == "" || b.Label == "" {
		return b, errors.New("demo_id and label are required")
	}
	// Verify demo exists
	var exists int
	if err := s.db.QueryRow(`SELECT 1 FROM demos WHERE id = ?`, b.DemoID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return b, ErrNotFound
		}
		return b, err
	}
	if b.ID == "" {
		b.ID = fmt.Sprintf("bm_%d", time.Now().UTC().UnixNano())
	}
	if b.CreatedAt == "" {
		b.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if b.CameraMode == "" {
		b.CameraMode = "pov"
	}
	_, err := s.db.Exec(`
		INSERT INTO demo_bookmarks (id, demo_id, round_number, tick, label, note, camera_mode, player_slot, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, b.ID, b.DemoID, b.Round, b.Tick, b.Label, b.Note, b.CameraMode, b.PlayerSlot, b.CreatedAt)
	return b, err
}

func (s *Store) DeleteBookmark(demoID, bookmarkID string) error {
	res, err := s.db.Exec(`DELETE FROM demo_bookmarks WHERE demo_id = ? AND id = ?`, demoID, bookmarkID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListAssetDirs() ([]string, error) {
	rows, err := s.db.Query(`SELECT path FROM map_asset_dirs ORDER BY added_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var dirs []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err == nil && p != "" {
			dirs = append(dirs, p)
		}
	}
	return dirs, rows.Err()
}

func (s *Store) AddAssetDir(dir string) error {
	clean := filepath.Clean(dir)
	_, err := s.db.Exec(`INSERT OR IGNORE INTO map_asset_dirs (path, added_at) VALUES (?, ?)`, clean, time.Now().UTC().Format(time.RFC3339))
	return err
}

func (s *Store) RemoveAssetDir(dir string) error {
	clean := filepath.Clean(dir)
	_, err := s.db.Exec(`DELETE FROM map_asset_dirs WHERE path = ?`, clean)
	return err
}
