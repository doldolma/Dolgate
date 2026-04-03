package hostsoverrideipc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
)

func sendRequestWithDialer(dial func() (net.Conn, error), request Request) (Response, error) {
	conn, err := dial()
	if err != nil {
		return Response{}, err
	}
	defer conn.Close()

	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return Response{}, fmt.Errorf("encode request: %w", err)
	}

	var response Response
	if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&response); err != nil {
		return Response{}, fmt.Errorf("decode response: %w", err)
	}
	return response, nil
}
