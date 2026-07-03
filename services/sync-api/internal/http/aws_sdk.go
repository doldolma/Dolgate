package http

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/ec2instanceconnect"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/sso"
	"github.com/aws/aws-sdk-go-v2/service/ssooidc"
	ssooidctypes "github.com/aws/aws-sdk-go-v2/service/ssooidc/types"
	"github.com/aws/smithy-go"
)

// This file is the only place sync-api talks to AWS: every operation that the
// server previously shelled out to the aws CLI for now goes through the Go SDK,
// so the runtime image needs no aws-cli or session-manager-plugin binaries.

const awsRequestTimeout = 30 * time.Second

// awsRequestConfig builds a request-scoped AWS config. Credentials come from
// the request's env map (mobile clients send the temporary credentials they
// obtained via SSO as AWS_* keys); when absent it falls back to the server's
// ambient credential chain, matching how the child aws CLI used to inherit the
// server process environment.
func awsRequestConfig(ctx context.Context, region string, env map[string]string) (aws.Config, error) {
	resolvedRegion := strings.TrimSpace(region)
	if resolvedRegion == "" {
		resolvedRegion = strings.TrimSpace(env["AWS_REGION"])
	}
	if resolvedRegion == "" {
		resolvedRegion = strings.TrimSpace(env["AWS_DEFAULT_REGION"])
	}
	if resolvedRegion == "" {
		return aws.Config{}, errors.New("AWS region이 지정되지 않았습니다.")
	}

	accessKeyID := strings.TrimSpace(env["AWS_ACCESS_KEY_ID"])
	secretAccessKey := strings.TrimSpace(env["AWS_SECRET_ACCESS_KEY"])
	if accessKeyID != "" && secretAccessKey != "" {
		return aws.Config{
			Region: resolvedRegion,
			Credentials: credentials.NewStaticCredentialsProvider(
				accessKeyID,
				secretAccessKey,
				strings.TrimSpace(env["AWS_SESSION_TOKEN"]),
			),
		}, nil
	}

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(resolvedRegion))
	if err != nil {
		return aws.Config{}, fmt.Errorf("AWS 자격 증명을 불러오지 못했습니다: %w", err)
	}
	return cfg, nil
}

// normalizeAwsSdkError extracts the most useful message from an SDK error the
// way normalizeAwsCliError used to pick error_description/message out of CLI
// output, so client-facing messages stay comparable.
func normalizeAwsSdkError(err error, fallback string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s (요청 시간 초과)", fallback)
	}
	if description := awsOidcErrorDescription(err); description != "" {
		return errors.New(description)
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		if message := strings.TrimSpace(apiError.ErrorMessage()); message != "" {
			return errors.New(message)
		}
		if code := strings.TrimSpace(apiError.ErrorCode()); code != "" {
			return fmt.Errorf("%s (%s)", fallback, code)
		}
	}
	return fmt.Errorf("%s: %v", fallback, err)
}

// awsOidcErrorDescription surfaces the OAuth error_description carried by SSO
// OIDC exceptions (expired/invalid codes and the like), which the generic
// smithy APIError message does not include.
func awsOidcErrorDescription(err error) string {
	var invalidGrant *ssooidctypes.InvalidGrantException
	if errors.As(err, &invalidGrant) {
		return strings.TrimSpace(aws.ToString(invalidGrant.Error_description))
	}
	var invalidClient *ssooidctypes.InvalidClientException
	if errors.As(err, &invalidClient) {
		return strings.TrimSpace(aws.ToString(invalidClient.Error_description))
	}
	var invalidRequest *ssooidctypes.InvalidRequestException
	if errors.As(err, &invalidRequest) {
		return strings.TrimSpace(aws.ToString(invalidRequest.Error_description))
	}
	var accessDenied *ssooidctypes.AccessDeniedException
	if errors.As(err, &accessDenied) {
		return strings.TrimSpace(aws.ToString(accessDenied.Error_description))
	}
	return ""
}

// --- AWS SSO / OIDC (mobile browser login flow) ---

type awsSsoAPI interface {
	RegisterClient(ctx context.Context, request awsSsoMobileLoginStartRequest) (*awsSsoRegisterClientResponse, error)
	CreateAuthorizationCodeToken(ctx context.Context, region, clientID, clientSecret, code, redirectURI, codeVerifier string) (*awsSsoCreateTokenResponse, error)
	CreateRefreshToken(ctx context.Context, region, clientID, clientSecret, refreshToken string) (*awsSsoCreateTokenResponse, error)
	GetRoleCredential(ctx context.Context, region, accountID, roleName, accessToken string) (*awsTemporaryCredentialPayload, error)
}

type sdkAwsSsoAPI struct{}

// oidcClient builds a per-region SSO OIDC client. Registration and token
// exchange are anonymous (OAuth) operations — no SigV4 credentials involved.
func (sdkAwsSsoAPI) oidcClient(region string) *ssooidc.Client {
	return ssooidc.New(ssooidc.Options{
		Region:      region,
		Credentials: aws.AnonymousCredentials{},
	})
}

func (sdkAwsSsoAPI) ssoClient(region string) *sso.Client {
	return sso.New(sso.Options{
		Region:      region,
		Credentials: aws.AnonymousCredentials{},
	})
}

func (api sdkAwsSsoAPI) RegisterClient(
	ctx context.Context,
	request awsSsoMobileLoginStartRequest,
) (*awsSsoRegisterClientResponse, error) {
	requestCtx, cancel := context.WithTimeout(ctx, awsRequestTimeout)
	defer cancel()

	output, err := api.oidcClient(request.SsoRegion).RegisterClient(requestCtx, &ssooidc.RegisterClientInput{
		ClientName:   aws.String("Dolgate Mobile"),
		ClientType:   aws.String("public"),
		IssuerUrl:    aws.String(request.SsoStartURL),
		RedirectUris: []string{request.RedirectURI},
		GrantTypes:   []string{awsSsoAuthorizationCodeGrantType, awsSsoRefreshTokenGrantType},
		Scopes:       []string{awsSsoRegistrationScope},
	})
	if err != nil {
		return nil, normalizeAwsSdkError(err, "AWS SSO client registration에 실패했습니다.")
	}
	return &awsSsoRegisterClientResponse{
		ClientID:     aws.ToString(output.ClientId),
		ClientSecret: aws.ToString(output.ClientSecret),
	}, nil
}

func (api sdkAwsSsoAPI) CreateAuthorizationCodeToken(
	ctx context.Context,
	region string,
	clientID string,
	clientSecret string,
	code string,
	redirectURI string,
	codeVerifier string,
) (*awsSsoCreateTokenResponse, error) {
	requestCtx, cancel := context.WithTimeout(ctx, awsRequestTimeout)
	defer cancel()

	output, err := api.oidcClient(region).CreateToken(requestCtx, &ssooidc.CreateTokenInput{
		ClientId:     aws.String(clientID),
		ClientSecret: aws.String(clientSecret),
		GrantType:    aws.String(awsSsoAuthorizationCodeGrantType),
		Code:         aws.String(code),
		RedirectUri:  aws.String(redirectURI),
		CodeVerifier: aws.String(codeVerifier),
	})
	if err != nil {
		return nil, normalizeAwsSdkError(err, "AWS SSO 토큰 교환에 실패했습니다.")
	}
	return &awsSsoCreateTokenResponse{
		AccessToken:  aws.ToString(output.AccessToken),
		RefreshToken: aws.ToString(output.RefreshToken),
		ExpiresIn:    output.ExpiresIn,
	}, nil
}

func (api sdkAwsSsoAPI) CreateRefreshToken(
	ctx context.Context,
	region string,
	clientID string,
	clientSecret string,
	refreshToken string,
) (*awsSsoCreateTokenResponse, error) {
	requestCtx, cancel := context.WithTimeout(ctx, awsRequestTimeout)
	defer cancel()

	output, err := api.oidcClient(region).CreateToken(requestCtx, &ssooidc.CreateTokenInput{
		ClientId:     aws.String(clientID),
		ClientSecret: aws.String(clientSecret),
		GrantType:    aws.String(awsSsoRefreshTokenGrantType),
		RefreshToken: aws.String(refreshToken),
	})
	if err != nil {
		return nil, normalizeAwsSdkError(err, "AWS SSO 토큰 갱신에 실패했습니다.")
	}
	return &awsSsoCreateTokenResponse{
		AccessToken:  aws.ToString(output.AccessToken),
		RefreshToken: aws.ToString(output.RefreshToken),
		ExpiresIn:    output.ExpiresIn,
	}, nil
}

func (api sdkAwsSsoAPI) GetRoleCredential(
	ctx context.Context,
	region string,
	accountID string,
	roleName string,
	accessToken string,
) (*awsTemporaryCredentialPayload, error) {
	requestCtx, cancel := context.WithTimeout(ctx, awsRequestTimeout)
	defer cancel()

	output, err := api.ssoClient(region).GetRoleCredentials(requestCtx, &sso.GetRoleCredentialsInput{
		AccountId:   aws.String(accountID),
		RoleName:    aws.String(roleName),
		AccessToken: aws.String(accessToken),
	})
	if err != nil {
		return nil, normalizeAwsSdkError(err, "AWS SSO role credential을 가져오지 못했습니다.")
	}
	roleCredentials := output.RoleCredentials
	if roleCredentials == nil ||
		strings.TrimSpace(aws.ToString(roleCredentials.AccessKeyId)) == "" ||
		strings.TrimSpace(aws.ToString(roleCredentials.SecretAccessKey)) == "" {
		return nil, errors.New("AWS SSO role credential을 가져오지 못했습니다.")
	}
	expiresAt := ""
	if roleCredentials.Expiration > 0 {
		expiresAt = time.UnixMilli(roleCredentials.Expiration).UTC().Format(time.RFC3339)
	}
	return &awsTemporaryCredentialPayload{
		AccessKeyID:     aws.ToString(roleCredentials.AccessKeyId),
		SecretAccessKey: aws.ToString(roleCredentials.SecretAccessKey),
		SessionToken:    aws.ToString(roleCredentials.SessionToken),
		ExpiresAt:       expiresAt,
	}, nil
}

// --- SSM session token issuance ---

// awsSsmSessionToken carries the ssm:StartSession output that ssh-core's
// in-process data channel needs; ssh-core itself never touches credentials.
type awsSsmSessionToken struct {
	SessionID  string
	StreamURL  string
	TokenValue string
}

type awsSsmTokenIssuer interface {
	IssueShellSession(ctx context.Context, region string, env map[string]string, instanceID string) (awsSsmSessionToken, error)
	IssuePortForwardSession(ctx context.Context, region string, env map[string]string, targetID string, targetPort int, localPort int) (awsSsmSessionToken, error)
}

type sdkAwsSsmTokenIssuer struct{}

func (sdkAwsSsmTokenIssuer) IssueShellSession(
	ctx context.Context,
	region string,
	env map[string]string,
	instanceID string,
) (awsSsmSessionToken, error) {
	return startSsmSession(ctx, region, env, &ssm.StartSessionInput{
		Target: aws.String(instanceID),
	}, "SSM 세션을 시작하지 못했습니다.")
}

func (sdkAwsSsmTokenIssuer) IssuePortForwardSession(
	ctx context.Context,
	region string,
	env map[string]string,
	targetID string,
	targetPort int,
	localPort int,
) (awsSsmSessionToken, error) {
	return startSsmSession(
		ctx,
		region,
		env,
		buildSsmPortForwardSessionInput(targetID, targetPort, localPort),
		"SSM 포트 포워딩 세션을 시작하지 못했습니다.",
	)
}

func buildSsmPortForwardSessionInput(targetID string, targetPort int, localPort int) *ssm.StartSessionInput {
	return &ssm.StartSessionInput{
		Target:       aws.String(targetID),
		DocumentName: aws.String("AWS-StartPortForwardingSession"),
		Parameters: map[string][]string{
			"portNumber":      {strconv.Itoa(targetPort)},
			"localPortNumber": {strconv.Itoa(localPort)},
		},
	}
}

func startSsmSession(
	ctx context.Context,
	region string,
	env map[string]string,
	input *ssm.StartSessionInput,
	fallbackMessage string,
) (awsSsmSessionToken, error) {
	requestCtx, cancel := context.WithTimeout(ctx, awsRequestTimeout)
	defer cancel()

	cfg, err := awsRequestConfig(requestCtx, region, env)
	if err != nil {
		return awsSsmSessionToken{}, err
	}
	output, err := ssm.NewFromConfig(cfg).StartSession(requestCtx, input)
	if err != nil {
		return awsSsmSessionToken{}, normalizeAwsSdkError(err, fallbackMessage)
	}
	token := awsSsmSessionToken{
		SessionID:  strings.TrimSpace(aws.ToString(output.SessionId)),
		StreamURL:  strings.TrimSpace(aws.ToString(output.StreamUrl)),
		TokenValue: strings.TrimSpace(aws.ToString(output.TokenValue)),
	}
	if token.SessionID == "" || token.StreamURL == "" || token.TokenValue == "" {
		return awsSsmSessionToken{}, errors.New("SSM 세션 응답에 스트림 정보가 없습니다.")
	}
	return token, nil
}

// --- EC2 Instance Connect (ephemeral SFTP key push) ---

type awsEc2InstanceConnectAPI interface {
	SendSSHPublicKey(ctx context.Context, request awsSftpCreateSessionRequest, publicKey string) error
}

type sdkAwsEc2InstanceConnect struct{}

func (sdkAwsEc2InstanceConnect) SendSSHPublicKey(
	ctx context.Context,
	request awsSftpCreateSessionRequest,
	publicKey string,
) error {
	requestCtx, cancel := context.WithTimeout(ctx, awsRequestTimeout)
	defer cancel()

	cfg, err := awsRequestConfig(requestCtx, request.Region, request.Env)
	if err != nil {
		return err
	}
	output, err := ec2instanceconnect.NewFromConfig(cfg).SendSSHPublicKey(requestCtx, &ec2instanceconnect.SendSSHPublicKeyInput{
		InstanceId:       aws.String(request.InstanceID),
		InstanceOSUser:   aws.String(request.SSHUsername),
		SSHPublicKey:     aws.String(publicKey),
		AvailabilityZone: aws.String(request.AvailabilityZone),
	})
	if err != nil {
		return normalizeAwsSdkError(err, "EC2 Instance Connect public key 전송에 실패했습니다.")
	}
	if !output.Success {
		return errors.New("EC2 Instance Connect public key was rejected")
	}
	return nil
}
