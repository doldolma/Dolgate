package http

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestAwsRequestConfigUsesRequestEnvCredentials(t *testing.T) {
	t.Parallel()

	cfg, err := awsRequestConfig(context.Background(), "ap-northeast-2", map[string]string{
		"AWS_ACCESS_KEY_ID":     "AKIAEXAMPLE",
		"AWS_SECRET_ACCESS_KEY": "secret",
		"AWS_SESSION_TOKEN":     "token",
	})
	if err != nil {
		t.Fatalf("awsRequestConfig() error = %v", err)
	}
	if cfg.Region != "ap-northeast-2" {
		t.Fatalf("Region = %q, want ap-northeast-2", cfg.Region)
	}
	credentials, err := cfg.Credentials.Retrieve(context.Background())
	if err != nil {
		t.Fatalf("Retrieve() error = %v", err)
	}
	if credentials.AccessKeyID != "AKIAEXAMPLE" ||
		credentials.SecretAccessKey != "secret" ||
		credentials.SessionToken != "token" {
		t.Fatalf("unexpected credentials %#v", credentials)
	}
}

func TestAwsRequestConfigResolvesRegionFromEnv(t *testing.T) {
	t.Parallel()

	cfg, err := awsRequestConfig(context.Background(), "", map[string]string{
		"AWS_ACCESS_KEY_ID":     "AKIAEXAMPLE",
		"AWS_SECRET_ACCESS_KEY": "secret",
		"AWS_REGION":            "us-east-1",
	})
	if err != nil {
		t.Fatalf("awsRequestConfig() error = %v", err)
	}
	if cfg.Region != "us-east-1" {
		t.Fatalf("Region = %q, want us-east-1", cfg.Region)
	}
}

func TestAwsRequestConfigRequiresRegion(t *testing.T) {
	t.Parallel()

	_, err := awsRequestConfig(context.Background(), "", map[string]string{
		"AWS_ACCESS_KEY_ID":     "AKIAEXAMPLE",
		"AWS_SECRET_ACCESS_KEY": "secret",
	})
	if err == nil || !strings.Contains(err.Error(), "region") {
		t.Fatalf("expected region error, got %v", err)
	}
}

func TestBuildSsmPortForwardSessionInputIncludesLocalPortNumber(t *testing.T) {
	t.Parallel()

	input := buildSsmPortForwardSessionInput("i-123", 22, 0)
	if input.Target == nil || *input.Target != "i-123" {
		t.Fatalf("Target = %v, want i-123", input.Target)
	}
	if input.DocumentName == nil || *input.DocumentName != "AWS-StartPortForwardingSession" {
		t.Fatalf("DocumentName = %v, want AWS-StartPortForwardingSession", input.DocumentName)
	}
	want := map[string][]string{
		"portNumber":      {"22"},
		"localPortNumber": {"0"},
	}
	if !reflect.DeepEqual(input.Parameters, want) {
		t.Fatalf("Parameters = %#v, want %#v", input.Parameters, want)
	}
}
