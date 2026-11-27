package parser

import (
	"bufio"
	"compress/bzip2"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/msg"
	st "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/sendtables"
)

var ErrInvalidDemo = errors.New("invalid or unreadable CS2 demo file")

// openDemoStream opens a .dem or .dem.bz2 file and returns a reader plus format ("dem" or "dem.bz2") and file size.
func openDemoStream(path string) (io.ReadCloser, string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, "", 0, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, "", 0, err
	}
	if st.IsDir() || st.Size() < 16 {
		f.Close()
		return nil, "", 0, fmt.Errorf("%w: empty or directory", ErrInvalidDemo)
	}
	br := bufio.NewReaderSize(f, 256*1024)
	magic, err := br.Peek(8)
	if err != nil && !errors.Is(err, io.EOF) {
		f.Close()
		return nil, "", 0, err
	}
	isBz2 := strings.HasSuffix(strings.ToLower(path), ".bz2") || (len(magic) >= 3 && magic[0] == 'B' && magic[1] == 'Z' && magic[2] == 'h')
	if isBz2 {
		return &compositeReadCloser{
			Reader: bzip2.NewReader(br),
			Closer: f,
		}, "dem.bz2", st.Size(), nil
	}
	// Check Valve Source 2 ("PBDEMS2\x00") or Source 1 ("HL2DEMO\x00") header
	if len(magic) >= 7 && string(magic[:7]) != "PBDEMS2" && string(magic[:7]) != "HL2DEMO" {
		f.Close()
		return nil, "", 0, fmt.Errorf("%w: unrecognized demo header", ErrInvalidDemo)
	}
	return &compositeReadCloser{
		Reader: br,
		Closer: f,
	}, "dem", st.Size(), nil
}

type compositeReadCloser struct {
	io.Reader
	io.Closer
}

func normalizeMapName(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	s = filepath.Base(s)
	s = strings.TrimSuffix(s, ".vpk")
	s = strings.TrimSuffix(s, ".bsp")
	return s
}

func round1(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*10) / 10
}

func round2(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*100) / 100
}

func clamp01(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func finiteCoord(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && math.Abs(v) <= 32767
}

func winReasonString(r events.RoundEndReason) string {
	switch r {
	case events.RoundEndReasonTargetBombed:
		return "Target Bombed"
	case events.RoundEndReasonBombDefused:
		return "Bomb Defused"
	case events.RoundEndReasonCTWin:
		return "CT Elimination"
	case events.RoundEndReasonTerroristsWin:
		return "T Elimination"
	case events.RoundEndReasonTargetSaved:
		return "Time Expired"
	case events.RoundEndReasonDraw:
		return "Round Draw"
	case events.RoundEndReasonTerroristsSurrender:
		return "T Surrender"
	case events.RoundEndReasonCTSurrender:
		return "CT Surrender"
	default:
		return fmt.Sprintf("Reason %d", r)
	}
}

func equipmentName(eq *common.Equipment) string {
	if eq == nil {
		return ""
	}
	return eq.String()
}

func grenadeTypeString(eq common.EquipmentType) string {
	switch eq {
	case common.EqSmoke:
		return "smoke"
	case common.EqFlash:
		return "flash"
	case common.EqHE:
		return "he"
	case common.EqMolotov:
		return "molotov"
	case common.EqIncendiary:
		return "incendiary"
	case common.EqDecoy:
		return "decoy"
	default:
		return ""
	}
}

func readGameRulesTimes(gs demoinfocs.GameState) (roundSec, freezeSec, bombSec int) {
	roundSec = 115
	freezeSec = 15
	bombSec = 40
	rules := gs.Rules()
	if rules == nil {
		return
	}
	if rt, err := rules.RoundTime(); err == nil && rt > 0 {
		roundSec = int(math.Round(rt.Seconds()))
	}
	if ft, err := rules.FreezeTime(); err == nil && ft >= 0 {
		freezeSec = int(math.Round(ft.Seconds()))
	}
	if bt, err := rules.BombTime(); err == nil && bt > 0 {
		bombSec = int(math.Round(bt.Seconds()))
	} else if cv := rules.ConVars(); cv != nil {
		if raw := strings.TrimSpace(cv["mp_c4timer"]); raw != "" {
			if v, err := strconv.Atoi(raw); err == nil && v > 0 {
				bombSec = v
			}
		}
	}
	return
}

func readRoundPause(gs demoinfocs.GameState, tick int, paused bool) RoundPause {
	state := RoundPause{Tick: tick}
	if rules := gs.Rules(); rules != nil && rules.Entity() != nil {
		prop := func(name string) st.Property {
			if p := rules.Entity().Property("m_pGameRules." + name); p != nil {
				return p
			}
			return rules.Entity().Property(name)
		}
		for _, side := range []struct {
			name string
			team common.Team
		}{{"CT", common.TeamCounterTerrorists}, {"Terrorist", common.TeamTerrorists}} {
			if p := prop("m_b" + side.name + "TimeOutActive"); p != nil && p.Value().BoolVal() {
				state.Kind = "timeout"
				state.Team = int(side.team)
				if remaining := prop("m_fl" + side.name + "TimeOutRemaining"); remaining != nil {
					seconds := math.Max(0, float64(remaining.Value().Float()))
					if !math.IsInf(seconds, 0) && !math.IsNaN(seconds) {
						state.SecondsLeft = &seconds
					}
				}
				return state
			}
		}
		if p := prop("m_bTechnicalTimeOut"); p != nil && p.Value().BoolVal() {
			state.Kind = "pause"
			return state
		}
	}
	if paused {
		state.Kind = "pause"
	}
	return state
}

func appendPauseChange(states []RoundPause, state RoundPause, rate float64) []RoundPause {
	if len(states) == 0 {
		if state.Kind != "" {
			return append(states, state)
		}
		return states
	}
	prev := states[len(states)-1]
	if prev.Kind == state.Kind && prev.Team == state.Team {
		if prev.SecondsLeft == nil && state.SecondsLeft == nil {
			return states
		}
		if prev.SecondsLeft != nil && state.SecondsLeft != nil {
			expected := math.Max(0, *prev.SecondsLeft-float64(state.Tick-prev.Tick)/rate)
			if math.Abs(expected-*state.SecondsLeft) < 0.5 {
				return states
			}
		}
	}
	return append(states, state)
}

func playerLoadout(pl *common.Player, active *common.Equipment) (int, [3]*common.Equipment) {
	var slots [3]*common.Equipment
	var smoke, flash, he, molly, decoy, c4 int
	for _, w := range pl.Inventory {
		if w == nil {
			continue
		}
		slot := -1
		switch w.Class() {
		case common.EqClassPistols:
			slot = 1
		case common.EqClassSMG, common.EqClassHeavy, common.EqClassRifle:
			slot = 0
		}
		if w.Type == common.EqKnife {
			slot = 2
		}
		if slot >= 0 && (slots[slot] == nil || w == active || (slots[slot] != active && w.Type < slots[slot].Type)) {
			slots[slot] = w
		}
		switch w.Type {
		case common.EqSmoke:
			smoke++
		case common.EqFlash:
			flash++
		case common.EqHE:
			he++
		case common.EqMolotov, common.EqIncendiary:
			molly++
		case common.EqDecoy:
			decoy++
		case common.EqBomb:
			c4++
		}
	}
	clamp9 := func(v int) int {
		if v < 0 {
			return 0
		}
		if v > 9 {
			return 9
		}
		return v
	}
	return clamp9(smoke) +
		clamp9(flash)*10 +
		clamp9(he)*100 +
		clamp9(molly)*1000 +
		clamp9(decoy)*10000 +
		clamp9(c4)*100000, slots
}

func readAimPunch(pawn st.Entity) (float64, float64) {
	if pawn == nil {
		return 0, 0
	}
	for _, key := range []string{
		"m_pCameraServices.m_vecCsViewPunchAngle",
		"m_pAimPunchServices.m_predictableBaseAngle",
		"m_aimPunchAngle",
	} {
		if prop, ok := pawn.PropertyValue(key); ok && prop.Any != nil {
			vec := prop.R3Vec()
			if !math.IsNaN(vec.X) && !math.IsNaN(vec.Y) {
				return round2(vec.X), round2(vec.Y)
			}
		}
	}
	return 0, 0
}

// ParseDemo parses a .dem or .dem.bz2 file into full match metadata, scoreboard, rounds, and 64Hz tick replays.
func ParseDemo(demoID string, demoPath string) (*ParsedMatch, error) {
	rc, format, fileSize, err := openDemoStream(demoPath)
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	cfg := demoinfocs.DefaultParserConfig
	cfg.IgnorePacketEntitiesPanic = true
	p := demoinfocs.NewParserWithConfig(rc, cfg)
	defer p.Close()

	var mapName string
	p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_ServerInfo) {
		if m.GetMapName() != "" {
			mapName = normalizeMapName(m.GetMapName())
		}
	})
	var recordingPlayer uint64
	p.RegisterEventHandler(func(e events.POVRecordingPlayerDetected) {
		if !e.PlayerInfo.IsHltv && !e.PlayerInfo.IsFakePlayer {
			recordingPlayer = e.PlayerInfo.XUID
		}
	})
	var paused bool
	p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_SetPause) {
		paused = m.GetPaused()
	})

	type roundAcc struct {
		summary       RoundSummary
		weaponIndex   map[string]int
		weapons       []string
		places        []string
		placeIndex    map[string]int
		kills         []KillEvent
		shots         []ShotEvent
		hurts         []HurtEvent
		smokes        []SmokeVolume
		openSmokes    map[int]int
		grenades      []GrenadeEvent
		projToGrenade map[int64]int
		decoyToGren   map[int]int
		infernos      []InfernoZone
		openInfernos  map[int64]int
		bombEvents    []BombEvent
		pauses        []RoundPause
		mvp           *RoundMVP
		overtime      int
		frames        []Frame
		firedThisTick map[int]bool
		roundKills    map[int]int
		bombState     float64 // 0=idle/dropped, 1=carried, 2=planting, 3=planted, 4=defused, 5=exploded
		lastTick      int
		ended         bool
	}

	rosterBySteam := make(map[string]*PlayerSummary)
	var rosterOrder []*PlayerSummary

	ensurePlayer := func(pl *common.Player) *PlayerSummary {
		if pl == nil || pl.SteamID64 == 0 || pl.IsBot {
			return nil
		}
		sid := strconv.FormatUint(pl.SteamID64, 10)
		ps, ok := rosterBySteam[sid]
		if ok {
			if pl.Name != "" {
				ps.Name = pl.Name
			}
			if pl.Team == common.TeamTerrorists || pl.Team == common.TeamCounterTerrorists {
				if ps.StartTeam == 0 {
					ps.StartTeam = int(pl.Team)
				}
				ps.Team = int(pl.Team)
			}
			return ps
		}
		team := int(pl.Team)
		if team != int(common.TeamTerrorists) && team != int(common.TeamCounterTerrorists) {
			team = 0
		}
		ps = &PlayerSummary{
			Slot:      len(rosterOrder),
			SteamID:   sid,
			Name:      pl.Name,
			StartTeam: team,
			Team:      team,
		}
		rosterBySteam[sid] = ps
		rosterOrder = append(rosterOrder, ps)
		return ps
	}

	slotOf := func(pl *common.Player) int {
		ps := ensurePlayer(pl)
		if ps == nil {
			return -1
		}
		return ps.Slot
	}

	var rounds []*roundAcc
	var cur *roundAcc
	var allKills []KillEvent
	matchLive := false
	matchStartSeen := false
	firstTick := -1
	lastTick := 0
	scoreCT := 0
	scoreT := 0

	weaponIdx := func(r *roundAcc, name string) int {
		if name == "" {
			return -1
		}
		if idx, ok := r.weaponIndex[name]; ok {
			return idx
		}
		idx := len(r.weapons)
		r.weapons = append(r.weapons, name)
		r.weaponIndex[name] = idx
		return idx
	}

	resetForLiveMatch := func() {
		rounds = nil
		cur = nil
		allKills = nil
		scoreCT = 0
		scoreT = 0
		for _, ps := range rosterOrder {
			ps.Kills = 0
			ps.Deaths = 0
			ps.Assists = 0
			ps.Headshots = 0
			ps.Damage = 0
			ps.StartTeam = ps.Team
		}
	}

	startNewRound := func(tick int) {
		gs := p.GameState()
		if gs.IsWarmupPeriod() {
			return
		}
		// Snapshot current playing participants into the roster
		for _, pl := range gs.Participants().Playing() {
			ensurePlayer(pl)
		}
		roundNum := len(rounds) + 1
		rSec, fSec, bSec := readGameRulesTimes(gs)
		cur = &roundAcc{
			summary: RoundSummary{
				RoundNumber:   roundNum,
				StartTick:     tick,
				ScoreCT:       gs.TeamCounterTerrorists().Score(),
				ScoreT:        gs.TeamTerrorists().Score(),
				RoundTimeSec:  rSec,
				FreezeTimeSec: fSec,
				BombTimeSec:   bSec,
			},
			weaponIndex:   make(map[string]int),
			openSmokes:    make(map[int]int),
			projToGrenade: make(map[int64]int),
			decoyToGren:   make(map[int]int),
			openInfernos:  make(map[int64]int),
			firedThisTick: make(map[int]bool),
			roundKills:    make(map[int]int),
			lastTick:      -1,
		}
		rounds = append(rounds, cur)
	}

	p.RegisterEventHandler(func(events.MatchStart) {
		matchLive = true
		if !matchStartSeen && p.GameState().TotalRoundsPlayed() == 0 {
			matchStartSeen = true
			resetForLiveMatch()
		}
	})

	p.RegisterEventHandler(func(e events.MatchStartedChanged) {
		if !e.OldIsStarted && e.NewIsStarted {
			matchLive = true
			if p.GameState().TotalRoundsPlayed() == 0 {
				resetForLiveMatch()
			}
		}
	})

	p.RegisterEventHandler(func(e events.IsWarmupPeriodChanged) {
		if e.OldIsWarmupPeriod && !e.NewIsWarmupPeriod {
			matchLive = true
			if p.GameState().TotalRoundsPlayed() == 0 {
				resetForLiveMatch()
			}
		}
	})

	p.RegisterEventHandler(func(e events.RoundStart) {
		gs := p.GameState()
		if gs.IsWarmupPeriod() {
			return
		}
		matchLive = true
		tick := gs.IngameTick()
		if cur != nil && !cur.ended && cur.summary.EndTick == 0 {
			cur.summary.EndTick = tick
			cur.summary.OfficialEndTick = tick
		}
		// Close any open smokes/infernos/decoys from previous round
		if cur != nil {
			for _, idx := range cur.openSmokes {
				if cur.smokes[idx].EndTick == 0 {
					cur.smokes[idx].EndTick = tick
				}
			}
			clear(cur.openSmokes)
			for _, idx := range cur.openInfernos {
				if cur.infernos[idx].EndTick == 0 {
					cur.infernos[idx].EndTick = tick
				}
			}
			clear(cur.openInfernos)
			for _, idx := range cur.decoyToGren {
				if cur.grenades[idx].EndTick == 0 {
					cur.grenades[idx].EndTick = tick
				}
			}
			clear(cur.decoyToGren)
		}
		startNewRound(tick)
	})

	p.RegisterEventHandler(func(events.RoundFreezetimeEnd) {
		if cur != nil && cur.summary.FreezeEndTick == 0 {
			cur.summary.FreezeEndTick = p.GameState().IngameTick()
			rSec, fSec, bSec := readGameRulesTimes(p.GameState())
			if rSec > 0 {
				cur.summary.RoundTimeSec = rSec
			}
			if fSec >= 0 {
				cur.summary.FreezeTimeSec = fSec
			}
			if bSec > 0 {
				cur.summary.BombTimeSec = bSec
			}
		}
	})

	p.RegisterEventHandler(func(e events.RoundEnd) {
		if cur == nil {
			return
		}
		gs := p.GameState()
		tick := gs.IngameTick()
		cur.ended = true
		cur.summary.EndTick = tick
		cur.summary.OfficialEndTick = tick
		cur.summary.WinnerTeam = int(e.Winner)
		cur.summary.WinReason = winReasonString(e.Reason)

		ct := gs.TeamCounterTerrorists().Score()
		t := gs.TeamTerrorists().Score()
		if e.Winner == common.TeamCounterTerrorists && ct <= cur.summary.ScoreCT {
			ct = cur.summary.ScoreCT + 1
		} else if e.Winner == common.TeamTerrorists && t <= cur.summary.ScoreT {
			t = cur.summary.ScoreT + 1
		}
		cur.summary.ScoreCT = ct
		cur.summary.ScoreT = t
		scoreCT = ct
		scoreT = t
	})

	p.RegisterEventHandler(func(events.RoundEndOfficial) {
		if cur != nil {
			cur.summary.OfficialEndTick = p.GameState().IngameTick()
			cur.summary.ScoreCT = p.GameState().TeamCounterTerrorists().Score()
			cur.summary.ScoreT = p.GameState().TeamTerrorists().Score()
			scoreCT = cur.summary.ScoreCT
			scoreT = cur.summary.ScoreT
		}
	})

	p.RegisterEventHandler(func(e events.RoundMVPAnnouncement) {
		if cur != nil {
			if slot := slotOf(e.Player); slot >= 0 {
				cur.mvp = &RoundMVP{Slot: slot, Reason: int(e.Reason)}
			}
		}
	})

	p.RegisterEventHandler(func(e events.RankUpdate) {
		sid := strconv.FormatUint(e.SteamID64(), 10)
		if ps, ok := rosterBySteam[sid]; ok {
			ps.RankOld = e.RankOld
			ps.RankNew = e.RankNew
		}
	})

	p.RegisterEventHandler(func(e events.WeaponFire) {
		if cur == nil || p.GameState().IsWarmupPeriod() || e.Shooter == nil || e.Shooter.IsBot {
			return
		}
		if e.Weapon == nil {
			return
		}
		switch e.Weapon.Class() {
		case common.EqClassPistols, common.EqClassSMG, common.EqClassHeavy, common.EqClassRifle:
		default:
			return
		}
		slot := slotOf(e.Shooter)
		if slot < 0 {
			return
		}
		tick := p.GameState().IngameTick()
		cur.firedThisTick[slot] = true
		pos := e.Shooter.Position()
		cur.shots = append(cur.shots, ShotEvent{
			Tick:       tick,
			PlayerSlot: slot,
			Weapon:     equipmentName(e.Weapon),
			Origin:     [3]float64{round1(pos.X), round1(pos.Y), round1(pos.Z + 60)},
			Yaw:        round2(float64(e.Shooter.ViewDirectionX())),
			Pitch:      round2(float64(e.Shooter.ViewDirectionY())),
		})
	})

	p.RegisterEventHandler(func(e events.PlayerHurt) {
		if cur == nil || p.GameState().IsWarmupPeriod() {
			return
		}
		vSlot := slotOf(e.Player)
		aSlot := slotOf(e.Attacker)
		if e.Attacker != nil && e.Player != nil && e.Attacker != e.Player && e.Attacker.Team != e.Player.Team {
			if aps := ensurePlayer(e.Attacker); aps != nil {
				aps.Damage += max(0, e.HealthDamageTaken)
			}
		}
		if vSlot >= 0 {
			cur.hurts = append(cur.hurts, HurtEvent{
				Tick:         p.GameState().IngameTick(),
				AttackerSlot: aSlot,
				VictimSlot:   vSlot,
				DamageHP:     max(0, e.HealthDamageTaken),
				DamageArmor:  max(0, e.ArmorDamageTaken),
				Weapon:       equipmentName(e.Weapon),
				HitGroup:     int(e.HitGroup),
			})
		}
	})

	p.RegisterEventHandler(func(e events.Kill) {
		if cur == nil || p.GameState().IsWarmupPeriod() {
			return
		}
		tick := p.GameState().IngameTick()
		kSlot := slotOf(e.Killer)
		vSlot := slotOf(e.Victim)
		aSlot := slotOf(e.Assister)

		if kps := ensurePlayer(e.Killer); kps != nil && e.Victim != nil && e.Killer != e.Victim {
			if e.Killer.Team != e.Victim.Team {
				kps.Kills++
				if e.IsHeadshot {
					kps.Headshots++
				}
			} else {
				kps.Kills--
			}
		}
		if vps := ensurePlayer(e.Victim); vps != nil {
			vps.Deaths++
		}
		if aps := ensurePlayer(e.Assister); aps != nil && e.Victim != nil && e.Assister.Team != e.Victim.Team {
			aps.Assists++
		}

		var kPos, vPos [3]float64
		kName, kTeam := "World", 0
		if e.Killer != nil {
			kName = e.Killer.Name
			kTeam = int(e.Killer.Team)
			kp := e.Killer.Position()
			kPos = [3]float64{round1(kp.X), round1(kp.Y), round1(kp.Z)}
		}
		vName, vTeam := "Unknown", 0
		if e.Victim != nil {
			vName = e.Victim.Name
			vTeam = int(e.Victim.Team)
			vp := e.Victim.Position()
			vPos = [3]float64{round1(vp.X), round1(vp.Y), round1(vp.Z)}
		}
		aName := ""
		aTeam := 0
		if e.Assister != nil {
			aName = e.Assister.Name
			aTeam = int(e.Assister.Team)
		}
		if kSlot >= 0 && e.Killer != nil && e.Victim != nil && e.Killer.Team != e.Victim.Team {
			cur.roundKills[kSlot]++
		}

		ke := KillEvent{
			Round:         cur.summary.RoundNumber,
			Tick:          tick,
			KillerSlot:    kSlot,
			KillerName:    kName,
			KillerTeam:    kTeam,
			VictimSlot:    vSlot,
			VictimName:    vName,
			VictimTeam:    vTeam,
			AssisterSlot:  aSlot,
			AssisterName:  aName,
			AssisterTeam:  aTeam,
			AssistedFlash: e.AssistedFlash,
			Weapon:        equipmentName(e.Weapon),
			Headshot:      e.IsHeadshot,
			Wallbang:      e.PenetratedObjects > 0,
			ThroughSmoke:  e.ThroughSmoke,
			AttackerBlind: e.AttackerBlind,
			NoScope:       e.NoScope,
			KillerPos:     kPos,
			VictimPos:     vPos,
		}
		cur.kills = append(cur.kills, ke)
		cur.summary.KillCount++
		allKills = append(allKills, ke)
	})

	attachDetonation := func(gType string, thrower *common.Player, pos [3]float64, tick int, durationTicks int) int {
		bestIdx := -1
		bestDist := 180.0 * 180.0
		tSlot := slotOf(thrower)
		for idx := len(cur.grenades) - 1; idx >= 0; idx-- {
			g := &cur.grenades[idx]
			if g.DetTick > 0 || g.Type != gType {
				continue
			}
			if len(g.Trajectory) > 0 {
				last := g.Trajectory[len(g.Trajectory)-1]
				dx := last[1] - pos[0]
				dy := last[2] - pos[1]
				dz := last[3] - pos[2]
				d2 := dx*dx + dy*dy + dz*dz
				if d2 < bestDist {
					bestDist = d2
					bestIdx = idx
				}
			} else if tSlot >= 0 && g.ThrowerSlot == tSlot {
				bestIdx = idx
				break
			}
		}
		if bestIdx >= 0 {
			g := &cur.grenades[bestIdx]
			g.DetTick = tick
			if durationTicks > 0 {
				g.EndTick = tick + durationTicks
			}
			g.Position = pos
			if g.ThrowerSlot < 0 && tSlot >= 0 {
				g.ThrowerSlot = tSlot
			}
			return bestIdx
		}
		idx := len(cur.grenades)
		endTick := 0
		if durationTicks > 0 {
			endTick = tick + durationTicks
		}
		cur.grenades = append(cur.grenades, GrenadeEvent{
			ID:          idx + 1,
			Type:        gType,
			ThrowerSlot: tSlot,
			ThrowTick:   tick,
			DetTick:     tick,
			EndTick:     endTick,
			Position:    pos,
		})
		return idx
	}

	p.RegisterEventHandler(func(e events.SmokeStart) {
		if cur == nil || p.GameState().IsWarmupPeriod() {
			return
		}
		if !finiteCoord(e.Position.X) || !finiteCoord(e.Position.Y) || !finiteCoord(e.Position.Z) {
			return
		}
		tick := p.GameState().IngameTick()
		if prev, exists := cur.openSmokes[e.GrenadeEntityID]; exists {
			cur.smokes[prev].EndTick = tick
		}
		pos := [3]float64{round1(e.Position.X), round1(e.Position.Y), round1(e.Position.Z)}
		idx := len(cur.smokes)
		cur.openSmokes[e.GrenadeEntityID] = idx
		cur.smokes = append(cur.smokes, SmokeVolume{
			ID:          idx + 1,
			StartTick:   tick,
			EndTick:     0,
			Position:    pos,
			ThrowerSlot: slotOf(e.Thrower),
		})
		rate := p.TickRate()
		if rate <= 0 {
			rate = 64
		}
		attachDetonation("smoke", e.Thrower, pos, tick, int(math.Round(20.0*rate)))
	})

	p.RegisterEventHandler(func(e events.SmokeExpired) {
		if cur == nil {
			return
		}
		tick := p.GameState().IngameTick()
		if idx, exists := cur.openSmokes[e.GrenadeEntityID]; exists {
			cur.smokes[idx].EndTick = tick
			delete(cur.openSmokes, e.GrenadeEntityID)
		}
	})

	p.RegisterEventHandler(func(e events.HeExplode) {
		if cur == nil || p.GameState().IsWarmupPeriod() {
			return
		}
		if !finiteCoord(e.Position.X) || !finiteCoord(e.Position.Y) || !finiteCoord(e.Position.Z) {
			return
		}
		rate := p.TickRate()
		if rate <= 0 {
			rate = 64
		}
		pos := [3]float64{round1(e.Position.X), round1(e.Position.Y), round1(e.Position.Z)}
		attachDetonation("he", e.Thrower, pos, p.GameState().IngameTick(), int(math.Round(0.95*rate)))
	})

	p.RegisterEventHandler(func(e events.FlashExplode) {
		if cur == nil || p.GameState().IsWarmupPeriod() {
			return
		}
		if !finiteCoord(e.Position.X) || !finiteCoord(e.Position.Y) || !finiteCoord(e.Position.Z) {
			return
		}
		rate := p.TickRate()
		if rate <= 0 {
			rate = 64
		}
		pos := [3]float64{round1(e.Position.X), round1(e.Position.Y), round1(e.Position.Z)}
		attachDetonation("flash", e.Thrower, pos, p.GameState().IngameTick(), int(math.Round(0.85*rate)))
	})

	p.RegisterEventHandler(func(e events.DecoyStart) {
		if cur == nil || p.GameState().IsWarmupPeriod() {
			return
		}
		if !finiteCoord(e.Position.X) || !finiteCoord(e.Position.Y) || !finiteCoord(e.Position.Z) {
			return
		}
		rate := p.TickRate()
		if rate <= 0 {
			rate = 64
		}
		pos := [3]float64{round1(e.Position.X), round1(e.Position.Y), round1(e.Position.Z)}
		gIdx := attachDetonation("decoy", e.Thrower, pos, p.GameState().IngameTick(), int(math.Round(15.0*rate)))
		cur.decoyToGren[e.GrenadeEntityID] = gIdx
	})

	p.RegisterEventHandler(func(e events.DecoyExpired) {
		if cur == nil {
			return
		}
		if gIdx, ok := cur.decoyToGren[e.GrenadeEntityID]; ok {
			cur.grenades[gIdx].EndTick = p.GameState().IngameTick()
			delete(cur.decoyToGren, e.GrenadeEntityID)
		}
	})

	p.RegisterEventHandler(func(e events.InfernoStart) {
		if cur == nil || p.GameState().IsWarmupPeriod() || e.Inferno == nil {
			return
		}
		tick := p.GameState().IngameTick()
		fires := e.Inferno.Fires().Active().List()
		pts := make([][3]float64, 0, len(fires))
		var sx, sy, sz float64
		for _, f := range fires {
			if !finiteCoord(f.X) || !finiteCoord(f.Y) || !finiteCoord(f.Z) {
				continue
			}
			pts = append(pts, [3]float64{round1(f.X), round1(f.Y), round1(f.Z)})
			sx += f.X
			sy += f.Y
			sz += f.Z
		}
		var center [3]float64
		if len(pts) > 0 {
			center = [3]float64{round1(sx / float64(len(pts))), round1(sy / float64(len(pts))), round1(sz / float64(len(pts)))}
		}
		infID := e.Inferno.UniqueID()
		if prev, exists := cur.openInfernos[infID]; exists {
			cur.infernos[prev].EndTick = tick
		}
		idx := len(cur.infernos)
		cur.openInfernos[infID] = idx
		cur.infernos = append(cur.infernos, InfernoZone{
			ID:          idx + 1,
			StartTick:   tick,
			EndTick:     0,
			ThrowerSlot: slotOf(e.Inferno.Thrower()),
			Center:      center,
			Points:      pts,
		})
		rate := p.TickRate()
		if rate <= 0 {
			rate = 64
		}
		if len(pts) > 0 {
			gIdx := attachDetonation("molotov", e.Inferno.Thrower(), center, tick, int(math.Round(7.0*rate)))
			if gIdx >= 0 && cur.grenades[gIdx].Type == "" {
				cur.grenades[gIdx].Type = "molotov"
			}
		}
	})

	p.RegisterEventHandler(func(e events.InfernoExpired) {
		if cur == nil || e.Inferno == nil {
			return
		}
		tick := p.GameState().IngameTick()
		if idx, exists := cur.openInfernos[e.Inferno.UniqueID()]; exists {
			cur.infernos[idx].EndTick = tick
			delete(cur.openInfernos, e.Inferno.UniqueID())
		}
	})

	recordBomb := func(kind string, pl *common.Player, site events.Bombsite, newState float64, hasKit bool, durSec float64) {
		if cur == nil {
			return
		}
		tick := p.GameState().IngameTick()
		pos := p.GameState().Bomb().Position()
		siteStr := ""
		if site == events.BombsiteA {
			siteStr = "A"
		} else if site == events.BombsiteB {
			siteStr = "B"
		}
		cur.bombState = newState
		cur.bombEvents = append(cur.bombEvents, BombEvent{
			Tick:        tick,
			Type:        kind,
			PlayerSlot:  slotOf(pl),
			Site:        siteStr,
			Position:    [3]float64{round1(pos.X), round1(pos.Y), round1(pos.Z)},
			HasKit:      hasKit,
			DurationSec: durSec,
		})
	}

	p.RegisterEventHandler(func(e events.BombPlantBegin) {
		recordBomb("plant_begin", e.Player, e.Site, 2, false, 3.2)
	})
	p.RegisterEventHandler(func(e events.BombPlantAborted) {
		recordBomb("plant_abort", e.Player, 0, 1, false, 0)
	})
	p.RegisterEventHandler(func(e events.BombPlanted) {
		if cur != nil {
			cur.summary.BombPlanted = true
			if e.Site == events.BombsiteA {
				cur.summary.BombSite = "A"
			} else if e.Site == events.BombsiteB {
				cur.summary.BombSite = "B"
			}
		}
		recordBomb("planted", e.Player, e.Site, 3, false, float64(max(1, cur.summary.BombTimeSec)))
	})
	p.RegisterEventHandler(func(e events.BombDefuseStart) {
		dur := 10.0
		if e.HasKit {
			dur = 5.0
		}
		recordBomb("defuse_begin", e.Player, 0, 3, e.HasKit, dur)
	})
	p.RegisterEventHandler(func(e events.BombDefuseAborted) {
		recordBomb("defuse_abort", e.Player, 0, 3, false, 0)
	})
	p.RegisterEventHandler(func(e events.BombDefused) {
		recordBomb("defused", e.Player, e.Site, 4, false, 0)
	})
	p.RegisterEventHandler(func(e events.BombExplode) {
		recordBomb("exploded", e.Player, e.Site, 5, false, 0)
	})
	p.RegisterEventHandler(func(e events.BombDropped) {
		if cur != nil && cur.bombState < 3 {
			recordBomb("dropped", e.Player, 0, 0, false, 0)
		}
	})
	p.RegisterEventHandler(func(e events.BombPickup) {
		if cur != nil && cur.bombState < 3 {
			recordBomb("pickup", e.Player, 0, 1, false, 0)
		}
	})

	p.RegisterEventHandler(func(events.FrameDone) {
		gs := p.GameState()
		tick := gs.IngameTick()
		if firstTick < 0 && tick > 0 {
			firstTick = tick
		}
		if tick > lastTick {
			lastTick = tick
		}
		if gs.IsWarmupPeriod() {
			return
		}
		// Some demos start already live without firing an initial RoundStart
		if cur == nil && (matchLive || gs.TotalRoundsPlayed() >= 0) {
			// Wait until at least 2 playing participants exist
			playing := gs.Participants().Playing()
			if len(playing) > 0 {
				startNewRound(tick)
			}
		}
		if cur == nil || tick <= cur.lastTick {
			return
		}
		cur.lastTick = tick
		cur.overtime = max(cur.overtime, gs.OvertimeCount())

		// Collect live participants indexed by slot
		bySlot := make([]*common.Player, len(rosterOrder))
		for _, pl := range gs.Participants().Playing() {
			if pl == nil || pl.IsBot || pl.SteamID64 == 0 {
				continue
			}
			ps := ensurePlayer(pl)
			if ps != nil {
				if ps.Slot >= len(bySlot) {
					grown := make([]*common.Player, len(rosterOrder))
					copy(grown, bySlot)
					bySlot = grown
				}
				bySlot[ps.Slot] = pl
			}
		}

		rate := p.TickRate()
		if rate <= 0 {
			rate = 64
		}

		playersTuple := make([][]float64, len(rosterOrder))
		cur.pauses = appendPauseChange(cur.pauses, readRoundPause(gs, tick, paused), rate)
		for slot, ps := range rosterOrder {
			var pl *common.Player
			if slot < len(bySlot) {
				pl = bySlot[slot]
			}
			if pl == nil {
				playersTuple[slot] = []float64{
					0, float64(ps.Team), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, 0,
					0, -1, -1, 0, 0, 0, 0, float64(cur.roundKills[slot]), -1, -1, -1, -1,
				}
				continue
			}
			alive := 0.0
			if pl.IsAlive() {
				alive = 1.0
			}
			team := float64(pl.Team)
			pos := pl.Position()
			x, y, z := round1(pos.X), round1(pos.Y), round1(pos.Z)
			if !finiteCoord(x) || !finiteCoord(y) || !finiteCoord(z) {
				x, y, z = 0, 0, 0
			}
			yaw := round2(float64(pl.ViewDirectionX()))
			pitch := round2(float64(pl.ViewDirectionY()))
			hp := float64(max(0, pl.Health()))
			armor := float64(max(0, pl.Armor()))

			duck := 0.0
			zoomLevel := 0.0
			flashFrac := 0.0
			flashAlpha := 0.0
			var punchPitch, punchYaw float64
			aw := pl.ActiveWeapon()
			if pawn := pl.PlayerPawnEntity(); pawn != nil {
				if prop := pawn.Property("m_pMovementServices.m_flDuckAmount"); prop != nil {
					duck = round2(clamp01(float64(prop.Value().Float())))
				} else if pl.IsDucking() {
					duck = 1.0
				}
				isScoped := false
				if prop := pawn.Property("m_bIsScoped"); prop != nil && prop.Value().BoolVal() {
					isScoped = true
				} else if pl.IsScoped() {
					isScoped = true
				}
				if isScoped {
					zLvl := 1
					if aw != nil && int(aw.ZoomLevel()) > 0 {
						zLvl = int(aw.ZoomLevel())
					}
					zoomLevel = float64(zLvl)
				}
				flashFrac, flashAlpha = readFlashState(pl, pawn, tick, rate)
				punchPitch, punchYaw = readAimPunch(pawn)
			}

			wIdx := weaponIdx(cur, equipmentName(aw))
			ammoMag, ammoRes := -1.0, -1.0
			if aw != nil {
				switch aw.Class() {
				case common.EqClassPistols, common.EqClassSMG, common.EqClassHeavy, common.EqClassRifle:
					ammoMag = float64(max(0, aw.AmmoInMagazine()))
					ammoRes = float64(max(0, aw.AmmoReserve()))
				}
			}

			flags := 0
			if pl.HasHelmet() {
				flags |= 1
			}
			if pl.HasDefuseKit() {
				flags |= 2
			}
			if cur.firedThisTick[slot] {
				flags |= 4
			}
			if pl.IsDefusing {
				flags |= 8
			}
			if pl.IsPlanting {
				flags |= 16
			}
			if pl.IsReloading {
				flags |= 32
			}

			utility, slots := playerLoadout(pl, aw)
			placeIdx := -1
			if place := pl.LastPlaceName(); place != "" {
				if cur.placeIndex == nil {
					cur.placeIndex = make(map[string]int)
				}
				if idx, ok := cur.placeIndex[place]; ok {
					placeIdx = idx
				} else {
					placeIdx = len(cur.places)
					cur.places = append(cur.places, place)
					cur.placeIndex[place] = placeIdx
				}
			}
			playersTuple[slot] = []float64{
				alive, team, x, y, z, yaw, pitch, hp, armor, duck, zoomLevel,
				flashFrac, flashAlpha, float64(wIdx), float64(flags),
				float64(max(0, pl.Money())), ammoMag, ammoRes,
				float64(max(0, pl.EquipmentValueCurrent())),
				float64(utility),
				punchPitch, punchYaw, float64(cur.roundKills[slot]),
				float64(weaponIdx(cur, equipmentName(slots[0]))), float64(weaponIdx(cur, equipmentName(slots[1]))),
				float64(weaponIdx(cur, equipmentName(slots[2]))), float64(placeIdx),
			}
		}
		clear(cur.firedThisTick)

		// Track active grenade projectiles in flight
		for _, gp := range gs.GrenadeProjectiles() {
			if gp == nil {
				continue
			}
			var gType string
			if gp.WeaponInstance != nil {
				gType = grenadeTypeString(gp.WeaponInstance.Type)
			}
			if gType == "" {
				continue
			}
			pos := gp.Position()
			if !finiteCoord(pos.X) || !finiteCoord(pos.Y) || !finiteCoord(pos.Z) {
				continue
			}
			px, py, pz := round1(pos.X), round1(pos.Y), round1(pos.Z)
			uid := gp.UniqueID()
			gIdx, exists := cur.projToGrenade[uid]
			if !exists {
				gIdx = len(cur.grenades)
				cur.projToGrenade[uid] = gIdx
				cur.grenades = append(cur.grenades, GrenadeEvent{
					ID:          gIdx + 1,
					Type:        gType,
					ThrowerSlot: slotOf(gp.Thrower),
					ThrowTick:   tick,
				})
			}
			g := &cur.grenades[gIdx]
			n := len(g.Trajectory)
			if n == 0 {
				g.Trajectory = append(g.Trajectory, [4]float64{float64(tick), px, py, pz})
			} else {
				last := g.Trajectory[n-1]
				dx := px - last[1]
				dy := py - last[2]
				dz := pz - last[3]
				if dx*dx+dy*dy+dz*dz >= 9.0 {
					g.Trajectory = append(g.Trajectory, [4]float64{float64(tick), px, py, pz})
				}
			}
		}

		// Update active inferno fire points when spread grows
		for _, inf := range gs.Infernos() {
			if inf == nil {
				continue
			}
			idx, ok := cur.openInfernos[inf.UniqueID()]
			if !ok {
				continue
			}
			fires := inf.Fires().Active().List()
			if len(fires) > len(cur.infernos[idx].Points) && len(fires) > 0 {
				pts := make([][3]float64, 0, min(24, len(fires)))
				var sx, sy, sz float64
				step := 1
				if len(fires) > 24 {
					step = len(fires) / 24
				}
				for i := 0; i < len(fires); i += step {
					f := fires[i]
					if !finiteCoord(f.X) || !finiteCoord(f.Y) || !finiteCoord(f.Z) {
						continue
					}
					pts = append(pts, [3]float64{round1(f.X), round1(f.Y), round1(f.Z)})
					sx += f.X
					sy += f.Y
					sz += f.Z
				}
				if len(pts) > 0 {
					cur.infernos[idx].Points = pts
					cur.infernos[idx].Center = [3]float64{
						round1(sx / float64(len(pts))),
						round1(sy / float64(len(pts))),
						round1(sz / float64(len(pts))),
					}
				}
			}
		}

		bomb := gs.Bomb()
		bombPos := bomb.Position()
		bx, by, bz := round1(bombPos.X), round1(bombPos.Y), round1(bombPos.Z)
		if !finiteCoord(bx) || !finiteCoord(by) || !finiteCoord(bz) {
			bx, by, bz = 0, 0, 0
		}
		carrierSlot := -1.0
		bombState := cur.bombState
		if bomb.Carrier != nil {
			if cs := slotOf(bomb.Carrier); cs >= 0 {
				carrierSlot = float64(cs)
				if bombState < 2 {
					bombState = 1
				}
			}
		} else if bombState == 1 {
			bombState = 0
		}

		cur.frames = append(cur.frames, Frame{
			Tick:    tick,
			Bomb:    [5]float64{bx, by, bz, carrierSlot, bombState},
			Players: playersTuple,
		})
	})

	if err := p.ParseToEnd(); err != nil {
		// Some demos truncate cleanly at EOF after match end; return error only if we got nothing usable
		if len(rounds) == 0 {
			return nil, fmt.Errorf("parse demo %s: %w", filepath.Base(demoPath), err)
		}
	}

	tickRate := p.TickRate()
	if tickRate <= 0 {
		tickRate = 64
	}
	if mapName == "" {
		mapName = strings.TrimSuffix(strings.TrimSuffix(filepath.Base(demoPath), ".bz2"), ".dem")
	}

	// Finalize rounds (drop completely empty trailing/phantom rounds with 0 frames)
	var validRounds []RoundSummary
	roundData := make(map[int]*RoundReplay)
	var recordedSlot *int
	if recordingPlayer != 0 {
		if ps := rosterBySteam[strconv.FormatUint(recordingPlayer, 10)]; ps != nil {
			recordedSlot = &ps.Slot
		}
	}
	for _, r := range rounds {
		if len(r.frames) == 0 {
			continue
		}
		firstFrameTick := r.frames[0].Tick
		lastFrameTick := r.frames[len(r.frames)-1].Tick
		if r.summary.StartTick == 0 {
			r.summary.StartTick = firstFrameTick
		}
		if r.summary.FreezeEndTick == 0 {
			r.summary.FreezeEndTick = r.summary.StartTick
		}
		if r.summary.EndTick == 0 {
			r.summary.EndTick = lastFrameTick
		}
		if r.summary.OfficialEndTick == 0 {
			r.summary.OfficialEndTick = lastFrameTick
		}
		// Close any remaining open smokes/infernos/decoys at round end
		for _, idx := range r.openSmokes {
			if r.smokes[idx].EndTick == 0 {
				r.smokes[idx].EndTick = lastFrameTick
			}
		}
		for _, idx := range r.openInfernos {
			if r.infernos[idx].EndTick == 0 {
				r.infernos[idx].EndTick = lastFrameTick
			}
		}
		for _, idx := range r.decoyToGren {
			if r.grenades[idx].EndTick == 0 {
				r.grenades[idx].EndTick = lastFrameTick
			}
		}
		r.summary.FrameCount = len(r.frames)
		rNum := len(validRounds) + 1
		r.summary.RoundNumber = rNum
		for i := range r.kills {
			r.kills[i].Round = rNum
		}

		validRounds = append(validRounds, r.summary)
		roundData[rNum] = &RoundReplay{
			SchemaVersion: CurrentReplaySchemaVersion,
			DemoID:        demoID,
			RoundNumber:   rNum,
			TickRate:      tickRate,
			POV:           recordingPlayer != 0,
			POVSlot:       recordedSlot,
			Overtime:      r.overtime,
			MVP:           r.mvp,
			Pauses:        r.pauses,
			Summary:       r.summary,
			Weapons:       r.weapons,
			Places:        r.places,
			Kills:         r.kills,
			Shots:         r.shots,
			Hurts:         r.hurts,
			Smokes:        r.smokes,
			Grenades:      r.grenades,
			Infernos:      r.infernos,
			BombEvents:    r.bombEvents,
			Frames:        r.frames,
		}
	}

	// Finalize player stats (ADR, HS%)
	numRounds := max(1, len(validRounds))
	players := make([]PlayerSummary, 0, len(rosterOrder))
	for _, ps := range rosterOrder {
		ps.ADR = round1(float64(ps.Damage) / float64(numRounds))
		if ps.Kills > 0 {
			ps.HSPct = round1(float64(ps.Headshots) * 100.0 / float64(ps.Kills))
		}
		players = append(players, *ps)
	}
	sort.SliceStable(players, func(i, j int) bool {
		if players[i].StartTeam != players[j].StartTeam {
			return players[i].StartTeam > players[j].StartTeam // CT (3) first, then T (2)
		}
		if players[i].Kills != players[j].Kills {
			return players[i].Kills > players[j].Kills
		}
		return players[i].Slot < players[j].Slot
	})

	if scoreCT == 0 && scoreT == 0 && len(validRounds) > 0 {
		lastR := validRounds[len(validRounds)-1]
		scoreCT = lastR.ScoreCT
		scoreT = lastR.ScoreT
	}

	totalTicks := lastTick
	if firstTick > 0 && lastTick >= firstTick {
		totalTicks = lastTick - firstTick
	}
	durationSec := round1(float64(totalTicks) / tickRate)

	return &ParsedMatch{
		Metadata: DemoMetadata{
			ID:          demoID,
			Filename:    filepath.Base(demoPath),
			SourcePath:  demoPath,
			Format:      format,
			FileSize:    fileSize,
			MapName:     mapName,
			TickRate:    round1(tickRate),
			TotalTicks:  totalTicks,
			DurationSec: durationSec,
			ScoreCT:     scoreCT,
			ScoreT:      scoreT,
			RoundCount:  len(validRounds),
			KillCount:   len(allKills),
			ParsedAt:    time.Now().UTC().Format(time.RFC3339),
			Status:      "ready",
		},
		Players:   players,
		Rounds:    validRounds,
		Kills:     allKills,
		RoundData: roundData,
	}, nil
}

func readFlashState(pl *common.Player, pawn st.Entity, tick int, rate float64) (float64, float64) {
	if pawn == nil {
		return 0, 0
	}
	durVal, ok := pawn.PropertyValue("m_flFlashDuration")
	if !ok || durVal.Any == nil {
		return 0, 0
	}
	seconds := float64(durVal.Float())
	if seconds <= 0 || seconds > 15 || math.IsNaN(seconds) {
		return 0, 0
	}
	start := pl.FlashTick
	if start <= 0 || start > tick {
		return 0, 0
	}
	end := start + int(math.Ceil(seconds*rate))
	if tick >= end {
		return 0, 0
	}
	rem := float64(end-tick) / float64(max(1, end-start))
	alpha := 1.0
	if aVal, ok := pawn.PropertyValue("m_flFlashMaxAlpha"); ok && aVal.Any != nil {
		a := float64(aVal.Float())
		if a >= 0 && a <= 255 && !math.IsNaN(a) {
			alpha = a / 255.0
		}
	}
	return round2(clamp01(rem)), round2(clamp01(alpha))
}
