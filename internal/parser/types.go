package parser

// DemoMetadata holds high-level match info stored in SQLite.
type DemoMetadata struct {
	ID          string  `json:"id"`
	Filename    string  `json:"filename"`
	SourcePath  string  `json:"source_path"`
	Format      string  `json:"format"` // "dem" or "dem.bz2"
	FileSize    int64   `json:"file_size"`
	MapName     string  `json:"map_name"`
	TickRate    float64 `json:"tick_rate"`
	TotalTicks  int     `json:"total_ticks"`
	DurationSec float64 `json:"duration_sec"`
	ScoreCT     int     `json:"score_ct"`
	ScoreT      int     `json:"score_t"`
	RoundCount  int     `json:"round_count"`
	KillCount   int     `json:"kill_count"`
	ParsedAt    string  `json:"parsed_at"`
	Status      string  `json:"status"`
}

// PlayerSummary represents one of the 10 match participants on the scoreboard.
type PlayerSummary struct {
	Slot      int     `json:"slot"` // 0..9 stable index in round frames
	SteamID   string  `json:"steam_id"`
	Name      string  `json:"name"`
	StartTeam int     `json:"start_team"` // 2 = T, 3 = CT (initial half team)
	Team      int     `json:"team"`       // 2 = T, 3 = CT (final team)
	Kills     int     `json:"kills"`
	Deaths    int     `json:"deaths"`
	Assists   int     `json:"assists"`
	Headshots int     `json:"headshots"`
	Damage    int     `json:"damage"`
	ADR       float64 `json:"adr"`
	HSPct     float64 `json:"hs_pct"`
	RankOld   int     `json:"rank_old,omitempty"`
	RankNew   int     `json:"rank_new,omitempty"`
}

const CurrentReplaySchemaVersion = 3

// RoundSummary holds round-level metadata and timeline markers.
type RoundSummary struct {
	RoundNumber     int    `json:"round_number"`
	StartTick       int    `json:"start_tick"`
	FreezeEndTick   int    `json:"freeze_end_tick"`
	EndTick         int    `json:"end_tick"`
	OfficialEndTick int    `json:"official_end_tick"`
	WinnerTeam      int    `json:"winner_team"` // 2 = T, 3 = CT, 0 = draw/unknown
	WinReason       string `json:"win_reason"`
	ScoreCT         int    `json:"score_ct"`
	ScoreT          int    `json:"score_t"`
	KillCount       int    `json:"kill_count"`
	BombPlanted     bool   `json:"bomb_planted"`
	BombSite        string `json:"bomb_site,omitempty"`
	FrameCount      int    `json:"frame_count"`
	RoundTimeSec    int    `json:"round_time_sec,omitempty"`
	FreezeTimeSec   int    `json:"freeze_time_sec,omitempty"`
	BombTimeSec     int    `json:"bomb_time_sec,omitempty"`
}

// KillEvent records a kill for the timeline, killfeed, and 3D event markers.
type KillEvent struct {
	Round         int        `json:"round"`
	Tick          int        `json:"tick"`
	KillerSlot    int        `json:"killer_slot"` // -1 for world/unknown
	KillerName    string     `json:"killer_name"`
	KillerTeam    int        `json:"killer_team"`
	VictimSlot    int        `json:"victim_slot"`
	VictimName    string     `json:"victim_name"`
	VictimTeam    int        `json:"victim_team"`
	AssisterSlot  int        `json:"assister_slot"`
	AssisterName  string     `json:"assister_name,omitempty"`
	AssisterTeam  int        `json:"assister_team,omitempty"`
	AssistedFlash bool       `json:"assisted_flash,omitempty"`
	Weapon        string     `json:"weapon"`
	Headshot      bool       `json:"headshot"`
	Wallbang      bool       `json:"wallbang"`
	ThroughSmoke  bool       `json:"through_smoke"`
	AttackerBlind bool       `json:"attacker_blind"`
	NoScope       bool       `json:"no_scope"`
	KillerPos     [3]float64 `json:"killer_pos"`
	VictimPos     [3]float64 `json:"victim_pos"`
}

// ShotEvent records a weapon fire tracer for 3D rendering.
type ShotEvent struct {
	Tick       int        `json:"tick"`
	PlayerSlot int        `json:"slot"`
	Weapon     string     `json:"weapon"`
	Origin     [3]float64 `json:"origin"`
	Yaw        float64    `json:"yaw"`
	Pitch      float64    `json:"pitch"`
}

// HurtEvent records damage inflicted for combat callouts.
type HurtEvent struct {
	Tick         int    `json:"tick"`
	AttackerSlot int    `json:"attacker_slot"`
	VictimSlot   int    `json:"victim_slot"`
	DamageHP     int    `json:"dmg_hp"`
	DamageArmor  int    `json:"dmg_armor"`
	Weapon       string `json:"weapon"`
	HitGroup     int    `json:"hit_group"`
}

// SmokeVolume records an active smoke grenade volume over ticks.
type SmokeVolume struct {
	ID          int        `json:"id"`
	StartTick   int        `json:"start_tick"`
	EndTick     int        `json:"end_tick"`
	Position    [3]float64 `json:"position"`
	ThrowerSlot int        `json:"thrower_slot"`
}

// GrenadeEvent tracks all CS2 grenade trajectories and detonations (smoke, flash, he, molotov, incendiary, decoy).
type GrenadeEvent struct {
	ID          int          `json:"id"`
	Type        string       `json:"type"`
	ThrowerSlot int          `json:"thrower_slot"`
	ThrowTick   int          `json:"throw_tick"`
	DetTick     int          `json:"det_tick"`
	EndTick     int          `json:"end_tick"`
	Position    [3]float64   `json:"position"`
	Trajectory  [][4]float64 `json:"traj,omitempty"` // [tick, x, y, z]
}

// InfernoZone records a Molotov/Incendiary floor fire zone over ticks.
type InfernoZone struct {
	ID          int          `json:"id"`
	StartTick   int          `json:"start_tick"`
	EndTick     int          `json:"end_tick"`
	ThrowerSlot int          `json:"thrower_slot"`
	Center      [3]float64   `json:"center"`
	Points      [][3]float64 `json:"points"`
}

// BombEvent records bomb state transitions in a round.
type BombEvent struct {
	Tick        int        `json:"tick"`
	Type        string     `json:"type"` // plant_begin, plant_abort, planted, defuse_begin, defuse_abort, defused, exploded, dropped, pickup
	PlayerSlot  int        `json:"player_slot"`
	Site        string     `json:"site,omitempty"`
	Position    [3]float64 `json:"position"`
	HasKit      bool       `json:"has_kit,omitempty"`
	DurationSec float64    `json:"duration_sec,omitempty"`
}

// Frame represents one simulation tick in a round.
// Player tuples are ordered by Roster slot 0..N-1.
// PlayerTuple fields:
//
//	[0] alive (0|1)
//	[1] team (0|2|3)
//	[2] x
//	[3] y
//	[4] z
//	[5] yaw (degrees)
//	[6] pitch (degrees)
//	[7] hp (0..100)
//	[8] armor (0..100)
//	[9] duck (0..1)
//	[10] zoomLevel (0=none, 1=zoom1, 2=zoom2)
//	[11] flashFrac (0..1 remaining blind intensity)
//	[12] flashAlpha (0..1 max alpha)
//	[13] weaponIdx (index into RoundReplay.Weapons, -1 if none)
//	[14] flags (bit0: helmet, bit1: defuser, bit2: firing, bit3: defusing, bit4: planting, bit5: reloading)
//	[15] money
//	[16] ammoMag (-1 if N/A)
//	[17] ammoRes (-1 if N/A)
//	[18] equipVal
//	[19] utilPacked (smoke + flash*10 + he*100 + molly*1000 + decoy*10000 + c4*100000)
//	[20] aimPunchPitch
//	[21] aimPunchYaw
//	[22] roundKills
//	[23:26] primary, secondary, knife indices into RoundReplay.Weapons (-1 if absent)
//	[26] place index into RoundReplay.Places (-1 if unavailable)
type Frame struct {
	Tick    int         `json:"t"`
	Bomb    [5]float64  `json:"b"` // [x, y, z, carrierSlot(-1 if none), state(0=idle/dropped,1=carried,2=planting,3=planted,4=defused,5=exploded)]
	Players [][]float64 `json:"p"`
}

type RoundPause struct {
	Tick        int      `json:"tick"`
	Kind        string   `json:"kind"`
	Team        int      `json:"team,omitempty"`
	SecondsLeft *float64 `json:"seconds_left,omitempty"`
}

type RoundMVP struct {
	Slot   int `json:"slot"`
	Reason int `json:"reason"`
}

// RoundReplay holds everything needed to play back one round in 3D.
type RoundReplay struct {
	SchemaVersion int            `json:"v,omitempty"`
	DemoID        string         `json:"demo_id"`
	RoundNumber   int            `json:"round_number"`
	TickRate      float64        `json:"tick_rate"`
	POV           bool           `json:"is_pov,omitempty"`
	POVSlot       *int           `json:"pov_slot,omitempty"`
	Overtime      int            `json:"overtime,omitempty"`
	MVP           *RoundMVP      `json:"mvp,omitempty"`
	Pauses        []RoundPause   `json:"pauses,omitempty"`
	Summary       RoundSummary   `json:"summary"`
	Weapons       []string       `json:"weapons"`
	Places        []string       `json:"places,omitempty"`
	Kills         []KillEvent    `json:"kills"`
	Shots         []ShotEvent    `json:"shots"`
	Hurts         []HurtEvent    `json:"hurts"`
	Smokes        []SmokeVolume  `json:"smokes"`
	Grenades      []GrenadeEvent `json:"grenades,omitempty"`
	Infernos      []InfernoZone  `json:"infernos,omitempty"`
	BombEvents    []BombEvent    `json:"bomb_events"`
	Frames        []Frame        `json:"frames"`
}

// ParsedMatch is the complete result of parsing a CS2 demo file.
type ParsedMatch struct {
	Metadata  DemoMetadata         `json:"metadata"`
	Players   []PlayerSummary      `json:"players"`
	Rounds    []RoundSummary       `json:"rounds"`
	Kills     []KillEvent          `json:"kills"`
	RoundData map[int]*RoundReplay `json:"-"`
}
