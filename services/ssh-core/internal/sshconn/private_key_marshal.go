package sshconn

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha512"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"

	"golang.org/x/crypto/blowfish"
	"golang.org/x/crypto/ssh"
)

const (
	openSSHPrivateKeyMagic       = "openssh-key-v1\x00"
	defaultPrivateKeyKDFRounds   = 16
	maxPrivateKeyKDFRounds       = 2048
	privateKeyCipherAES256CTR    = "aes256-ctr"
	privateKeyCipherAES256CBC    = "aes256-cbc"
	privateKeyBcryptPBKDFBlockSz = 32
)

type privateKeyEncryptionOptions struct {
	Passphrase []byte
	Cipher     string
	KDFRounds  int
}

type openSSHEncryptedPrivateKey struct {
	CipherName   string
	KdfName      string
	KdfOpts      string
	NumKeys      uint32
	PubKey       []byte
	PrivKeyBlock []byte
}

type openSSHPrivateKey struct {
	Check1  uint32
	Check2  uint32
	Keytype string
	Rest    []byte `ssh:"rest"`
}

type openSSHRSAPrivateKey struct {
	N       *big.Int
	E       *big.Int
	D       *big.Int
	Iqmp    *big.Int
	P       *big.Int
	Q       *big.Int
	Comment string
	Pad     []byte `ssh:"rest"`
}

type openSSHEd25519PrivateKey struct {
	Pub     []byte
	Priv    []byte
	Comment string
	Pad     []byte `ssh:"rest"`
}

type openSSHECDSAPrivateKey struct {
	Curve   string
	Pub     []byte
	D       *big.Int
	Comment string
	Pad     []byte `ssh:"rest"`
}

func normalizePrivateKeyCipher(value string) string {
	if value == privateKeyCipherAES256CBC {
		return privateKeyCipherAES256CBC
	}
	return privateKeyCipherAES256CTR
}

func normalizePrivateKeyKDFRounds(value int) int {
	if value < 1 {
		return defaultPrivateKeyKDFRounds
	}
	if value > maxPrivateKeyKDFRounds {
		return maxPrivateKeyKDFRounds
	}
	return value
}

func marshalOpenSSHPrivateKeyWithOptions(
	key crypto.PrivateKey,
	comment string,
	options privateKeyEncryptionOptions,
) (*pem.Block, string, int, error) {
	if len(options.Passphrase) == 0 {
		block, err := ssh.MarshalPrivateKey(key, comment)
		return block, "", 0, err
	}

	cipherName := normalizePrivateKeyCipher(options.Cipher)
	rounds := normalizePrivateKeyKDFRounds(options.KDFRounds)
	block, err := marshalOpenSSHPrivateKey(key, comment, func(privKeyBlock []byte) ([]byte, string, string, string, error) {
		return encryptOpenSSHPrivateKeyBlock(privKeyBlock, options.Passphrase, cipherName, rounds)
	})
	return block, cipherName, rounds, err
}

type openSSHEncryptFunc func(privKeyBlock []byte) (protectedKeyBlock []byte, cipherName, kdfName, kdfOptions string, err error)

func marshalOpenSSHPrivateKey(
	key crypto.PrivateKey,
	comment string,
	encrypt openSSHEncryptFunc,
) (*pem.Block, error) {
	var container openSSHEncryptedPrivateKey
	var privateBlock openSSHPrivateKey

	var check uint32
	if err := binary.Read(rand.Reader, binary.BigEndian, &check); err != nil {
		return nil, err
	}

	privateBlock.Check1 = check
	privateBlock.Check2 = check
	container.NumKeys = 1

	if value, ok := key.(*ed25519.PrivateKey); ok {
		key = *value
	}

	switch value := key.(type) {
	case *rsa.PrivateKey:
		e := new(big.Int).SetInt64(int64(value.PublicKey.E))
		container.PubKey = ssh.Marshal(struct {
			KeyType string
			E       *big.Int
			N       *big.Int
		}{
			ssh.KeyAlgoRSA,
			e,
			value.PublicKey.N,
		})
		privateBlock.Keytype = ssh.KeyAlgoRSA
		privateBlock.Rest = ssh.Marshal(openSSHRSAPrivateKey{
			N:       value.PublicKey.N,
			E:       e,
			D:       value.D,
			Iqmp:    value.Precomputed.Qinv,
			P:       value.Primes[0],
			Q:       value.Primes[1],
			Comment: comment,
		})
	case ed25519.PrivateKey:
		pub := make([]byte, ed25519.PublicKeySize)
		priv := make([]byte, ed25519.PrivateKeySize)
		copy(pub, value[32:])
		copy(priv, value)
		container.PubKey = ssh.Marshal(struct {
			KeyType string
			Pub     []byte
		}{
			ssh.KeyAlgoED25519,
			pub,
		})
		privateBlock.Keytype = ssh.KeyAlgoED25519
		privateBlock.Rest = ssh.Marshal(openSSHEd25519PrivateKey{
			Pub:     pub,
			Priv:    priv,
			Comment: comment,
		})
	case *ecdsa.PrivateKey:
		curveName, keyType, err := openSSHECDSAKeyType(value.Curve)
		if err != nil {
			return nil, err
		}
		pub := elliptic.Marshal(value.Curve, value.PublicKey.X, value.PublicKey.Y)
		container.PubKey = ssh.Marshal(struct {
			KeyType string
			Curve   string
			Pub     []byte
		}{
			keyType,
			curveName,
			pub,
		})
		privateBlock.Keytype = keyType
		privateBlock.Rest = ssh.Marshal(openSSHECDSAPrivateKey{
			Curve:   curveName,
			Pub:     pub,
			D:       value.D,
			Comment: comment,
		})
	default:
		return nil, fmt.Errorf("ssh: unsupported key type %T", value)
	}

	var err error
	container.PrivKeyBlock, container.CipherName, container.KdfName, container.KdfOpts, err = encrypt(ssh.Marshal(privateBlock))
	if err != nil {
		return nil, err
	}

	return &pem.Block{
		Type:  "OPENSSH PRIVATE KEY",
		Bytes: append([]byte(openSSHPrivateKeyMagic), ssh.Marshal(container)...),
	}, nil
}

func openSSHECDSAKeyType(curve elliptic.Curve) (string, string, error) {
	switch curve.Params().Name {
	case "P-256":
		return "nistp256", ssh.KeyAlgoECDSA256, nil
	case "P-384":
		return "nistp384", ssh.KeyAlgoECDSA384, nil
	case "P-521":
		return "nistp521", ssh.KeyAlgoECDSA521, nil
	default:
		return "", "", errors.New("ssh: unhandled elliptic curve " + curve.Params().Name)
	}
}

func encryptOpenSSHPrivateKeyBlock(
	privKeyBlock []byte,
	passphrase []byte,
	cipherName string,
	rounds int,
) ([]byte, string, string, string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, "", "", "", err
	}

	kdfOpts := struct {
		Salt   []byte
		Rounds uint32
	}{salt, uint32(rounds)}

	keyMaterial, err := bcryptPBKDF(passphrase, salt, rounds, 32+aes.BlockSize)
	if err != nil {
		return nil, "", "", "", err
	}

	keyBlock := generateOpenSSHPadding(privKeyBlock, aes.BlockSize)
	dst := make([]byte, len(keyBlock))
	key, iv := keyMaterial[:32], keyMaterial[32:]
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, "", "", "", err
	}

	switch cipherName {
	case privateKeyCipherAES256CBC:
		cipher.NewCBCEncrypter(block, iv).CryptBlocks(dst, keyBlock)
	default:
		stream := cipher.NewCTR(block, iv)
		stream.XORKeyStream(dst, keyBlock)
		cipherName = privateKeyCipherAES256CTR
	}

	return dst, cipherName, "bcrypt", string(ssh.Marshal(kdfOpts)), nil
}

func generateOpenSSHPadding(block []byte, blockSize int) []byte {
	for i, l := 0, len(block); (l+i)%blockSize != 0; i++ {
		block = append(block, byte(i+1))
	}
	return block
}

func bcryptPBKDF(password, salt []byte, rounds, keyLen int) ([]byte, error) {
	if rounds < 1 {
		return nil, errors.New("bcrypt_pbkdf: number of rounds is too small")
	}
	if len(password) == 0 {
		return nil, errors.New("bcrypt_pbkdf: empty password")
	}
	if len(salt) == 0 || len(salt) > 1<<20 {
		return nil, errors.New("bcrypt_pbkdf: bad salt length")
	}
	if keyLen > 1024 {
		return nil, errors.New("bcrypt_pbkdf: keyLen is too large")
	}

	numBlocks := (keyLen + privateKeyBcryptPBKDFBlockSz - 1) / privateKeyBcryptPBKDFBlockSz
	key := make([]byte, numBlocks*privateKeyBcryptPBKDFBlockSz)

	hash := sha512.New()
	hash.Write(password)
	shaPass := hash.Sum(nil)

	shaSalt := make([]byte, 0, sha512.Size)
	counter, tmp := make([]byte, 4), make([]byte, privateKeyBcryptPBKDFBlockSz)
	for blockIndex := 1; blockIndex <= numBlocks; blockIndex++ {
		hash.Reset()
		hash.Write(salt)
		counter[0] = byte(blockIndex >> 24)
		counter[1] = byte(blockIndex >> 16)
		counter[2] = byte(blockIndex >> 8)
		counter[3] = byte(blockIndex)
		hash.Write(counter)
		bcryptHash(tmp, shaPass, hash.Sum(shaSalt))

		out := make([]byte, privateKeyBcryptPBKDFBlockSz)
		copy(out, tmp)
		for round := 2; round <= rounds; round++ {
			hash.Reset()
			hash.Write(tmp)
			bcryptHash(tmp, shaPass, hash.Sum(shaSalt))
			for index := range out {
				out[index] ^= tmp[index]
			}
		}

		for index, value := range out {
			key[index*numBlocks+(blockIndex-1)] = value
		}
	}
	return key[:keyLen], nil
}

var bcryptMagic = []byte("OxychromaticBlowfishSwatDynamite")

func bcryptHash(out, shaPass, shaSalt []byte) {
	cipherBlock, err := blowfish.NewSaltedCipher(shaPass, shaSalt)
	if err != nil {
		panic(err)
	}
	for i := 0; i < 64; i++ {
		blowfish.ExpandKey(shaSalt, cipherBlock)
		blowfish.ExpandKey(shaPass, cipherBlock)
	}
	copy(out, bcryptMagic)
	for i := 0; i < privateKeyBcryptPBKDFBlockSz; i += 8 {
		for j := 0; j < 64; j++ {
			cipherBlock.Encrypt(out[i:i+8], out[i:i+8])
		}
	}
	for i := 0; i < privateKeyBcryptPBKDFBlockSz; i += 4 {
		out[i+3], out[i+2], out[i+1], out[i] = out[i], out[i+1], out[i+2], out[i+3]
	}
}
