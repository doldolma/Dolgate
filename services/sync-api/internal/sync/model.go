package sync

type Record struct {
	ID               string  `json:"id"`
	EncryptedPayload string  `json:"encrypted_payload"`
	UpdatedAt        string  `json:"updated_at"`
	DeletedAt        *string `json:"deleted_at,omitempty"`
}

type Payload struct {
	Hosts    []Record `json:"hosts"`
	Snippets []Record `json:"snippets"`
}
