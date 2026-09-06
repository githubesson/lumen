package apitracker

import (
	"regexp"
	"strconv"
	"strings"
)

// Metadata normalization lives separately from scanner orchestration so it can
// evolve and be tested without touching download and ingestion control flow.
func apiTrackerExtraText(entry Entry) string {
	parts := []string{
		fieldString(entry.Fields, "extra"),
		fieldString(entry.Fields, "description"),
		fieldString(entry.Fields, "notes"),
		fieldString(entry.Raw, "extra"),
		fieldString(entry.Raw, "description"),
		fieldString(entry.Raw, "notes"),
	}
	for _, key := range []string{"extra", "description", "notes"} {
		parts = append(parts, strings.Join(fieldStrings(entry.LessCommonFields, key), " "))
	}
	return strings.Join(parts, " ")
}

func apiTrackerProducer(entry Entry) string {
	for _, key := range []string{"producer", "producers", "prod", "produced_by", "produced by"} {
		values := fieldStrings(entry.LessCommonFields, key)
		for i := range values {
			values[i] = strings.TrimSpace(apiTrackerProdRe.ReplaceAllString(values[i], ""))
		}
		if value := strings.Join(nonEmptyStrings(values), ", "); value != "" {
			return value
		}
	}
	return ""
}

func apiTrackerFeatured(entry Entry) []string {
	out := []string{}
	for _, key := range []string{"featured", "features", "feature", "feat", "feats", "featuring", "ft"} {
		for _, value := range fieldStrings(entry.LessCommonFields, key) {
			out = append(out, splitCreditNames(apiTrackerFeatRe.ReplaceAllString(value, ""))...)
		}
	}
	return dedupeStrings(out)
}

func parseTitleCredits(title string, extraText string) (cleanTitle string, producer string, altTitle string, featured []string) {
	cleanTitle = strings.TrimSpace(title)
	for _, m := range apiTrackerCreditGroupRe.FindAllStringSubmatch(title+" "+extraText, -1) {
		if len(m) < 2 {
			continue
		}
		group := strings.TrimSpace(m[1])
		if group == "" {
			continue
		}
		switch {
		case apiTrackerProdRe.MatchString(group):
			if producer == "" {
				producer = strings.TrimSpace(apiTrackerProdRe.ReplaceAllString(group, ""))
			}
			cleanTitle = strings.TrimSpace(strings.Replace(cleanTitle, m[0], "", 1))
		case apiTrackerFeatRe.MatchString(group):
			names := splitCreditNames(apiTrackerFeatRe.ReplaceAllString(group, ""))
			featured = append(featured, names...)
			cleanTitle = strings.TrimSpace(strings.Replace(cleanTitle, m[0], "", 1))
		case altTitle == "" && strings.Contains(title, m[0]):
			altTitle = group
		}
	}
	cleanTitle = strings.Join(strings.Fields(cleanTitle), " ")
	return cleanTitle, producer, altTitle, dedupeStrings(featured)
}

func splitCreditNames(raw string) []string {
	raw = strings.NewReplacer(
		"&", ",",
		" x ", ",",
		" X ", ",",
		" feat. ", ",",
		" feat ", ",",
		" ft. ", ",",
		" ft ", ",",
		" featuring ", ",",
	).Replace(raw)
	parts := strings.Split(raw, ",")
	out := []string{}
	for _, part := range parts {
		for _, name := range strings.Split(part, " and ") {
			name = strings.TrimSpace(name)
			if name != "" {
				out = append(out, name)
			}
		}
	}
	return out
}

func fieldStrings(fields map[string]any, key string) []string {
	if fields == nil {
		return nil
	}
	for k, value := range fields {
		if strings.EqualFold(strings.TrimSpace(k), key) {
			return valueStrings(value)
		}
	}
	return nil
}

func valueStrings(value any) []string {
	switch v := value.(type) {
	case nil:
		return nil
	case []string:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if item = strings.TrimSpace(item); item != "" {
				out = append(out, item)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			out = append(out, valueStrings(item)...)
		}
		return out
	default:
		if s := anyString(v); s != "" {
			return []string{s}
		}
		return nil
	}
}

func dedupeStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := values[:0]
	for _, value := range values {
		key := strings.ToLower(strings.TrimSpace(value))
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, strings.TrimSpace(value))
	}
	return out
}

func nonEmptyStrings(values []string) []string {
	out := values[:0]
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func GuessPrimaryArtist(trackerName string) string {
	name := strings.TrimSpace(trackerName)
	for _, suffix := range []string{"Tracker", "Grid", "Sheet", "Spreadsheet", "List", "Leaks", "Archive", "Database"} {
		lowerName := strings.ToLower(name)
		lowerSuffix := strings.ToLower(suffix)
		if strings.HasSuffix(lowerName, " "+lowerSuffix) {
			return strings.TrimSpace(name[:len(name)-len(suffix)-1])
		}
		if strings.HasSuffix(lowerName, lowerSuffix) {
			return strings.TrimSpace(name[:len(name)-len(suffix)])
		}
	}
	return name
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func fieldString(fields map[string]any, key string) string {
	if fields == nil {
		return ""
	}
	if value := anyString(fields[key]); value != "" {
		return value
	}
	for k, value := range fields {
		if strings.EqualFold(k, key) {
			return anyString(value)
		}
	}
	return ""
}

func firstYear(values ...string) int {
	for _, value := range values {
		if y := ParseYear(value); y > 0 {
			return y
		}
	}
	return 0
}

var (
	yearPlainRe             = regexp.MustCompile(`\b(?:19|20)\d{2}\b`)
	apiTrackerCreditGroupRe = regexp.MustCompile(`\(([^()]+)\)`)
	apiTrackerProdRe        = regexp.MustCompile(`(?i)^(?:(?:prod|produced by)\.?)\s*`)
	apiTrackerFeatRe        = regexp.MustCompile(`(?i)^(?:(?:feat|ft|featuring|w/|with)\.?)\s*`)
)

func ParseYear(text string) int {
	if text == "" {
		return 0
	}
	if m := yearPlainRe.FindString(text); m != "" {
		if y, err := strconv.Atoi(m); err == nil {
			return y
		}
	}
	return 0
}
