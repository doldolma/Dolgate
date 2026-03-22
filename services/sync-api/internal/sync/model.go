package sync

type Kind string

const (
	KindGroups       Kind = "groups"
	KindHosts        Kind = "hosts"
	KindSecrets      Kind = "secrets"
	KindKnownHosts   Kind = "knownHosts"
	KindPortForwards Kind = "portForwards"
	KindPreferences  Kind = "preferences"
)

var AllKinds = []Kind{
	KindGroups,
	KindHosts,
	KindSecrets,
	KindKnownHosts,
	KindPortForwards,
	KindPreferences,
}

type Record struct {
	ID               string  `json:"id"`
	EncryptedPayload string  `json:"encrypted_payload"`
	UpdatedAt        string  `json:"updated_at"`
	DeletedAt        *string `json:"deleted_at,omitempty"`
}

type Payload struct {
	Groups       []Record `json:"groups"`
	Hosts        []Record `json:"hosts"`
	Secrets      []Record `json:"secrets"`
	KnownHosts   []Record `json:"knownHosts"`
	PortForwards []Record `json:"portForwards"`
	Preferences  []Record `json:"preferences"`
}
