package http

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"keyterm/services/sync-api/internal/auth"
	"keyterm/services/sync-api/internal/store"
	syncmodel "keyterm/services/sync-api/internal/sync"
)

type authRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken" binding:"required"`
}

type authResponse struct {
	UserID string         `json:"userId"`
	Email  string         `json:"email"`
	Tokens auth.TokenPair `json:"tokens"`
}

func NewRouter(store store.Store, authService *auth.Service) *gin.Engine {
	// 라우터는 얇게 유지하고 실제 정책은 auth/store 계층으로 위임한다.
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	router.GET("/healthz", func(ctx *gin.Context) {
		ctx.JSON(http.StatusOK, gin.H{"status": "ok", "time": time.Now().UTC().Format(time.RFC3339)})
	})

	router.POST("/auth/signup", func(ctx *gin.Context) {
		var request authRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		user, tokens, err := authService.Signup(ctx.Request.Context(), request.Email, request.Password)
		if err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusCreated, authResponse{
			UserID: user.ID,
			Email:  user.Email,
			Tokens: tokens,
		})
	})

	router.POST("/auth/login", func(ctx *gin.Context) {
		var request authRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		user, tokens, err := authService.Login(ctx.Request.Context(), request.Email, request.Password)
		if err != nil {
			// 자격 증명 오류는 401, 그 외 정책/입력 오류는 400으로 나눈다.
			status := http.StatusUnauthorized
			if !errors.Is(err, auth.ErrInvalidCredentials) {
				status = http.StatusBadRequest
			}
			ctx.JSON(status, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusOK, authResponse{
			UserID: user.ID,
			Email:  user.Email,
			Tokens: tokens,
		})
	})

	router.POST("/auth/refresh", func(ctx *gin.Context) {
		var request refreshRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		tokens, err := authService.Refresh(ctx.Request.Context(), request.RefreshToken)
		if err != nil {
			ctx.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"tokens": tokens})
	})

	syncGroup := router.Group("/sync")
	// /sync 전체는 access token 인증이 필수다.
	syncGroup.Use(authMiddleware(authService))
	syncGroup.GET("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		// 서버는 payload 내용을 해석하지 않고 사용자별로 레코드만 모아 반환한다.
		hosts, err := store.ListSyncRecords(ctx.Request.Context(), userID, "hosts")
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		snippets, err := store.ListSyncRecords(ctx.Request.Context(), userID, "snippets")
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusOK, syncmodel.Payload{
			Hosts:    hosts,
			Snippets: snippets,
		})
	})
	syncGroup.POST("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		var payload syncmodel.Payload
		if err := ctx.ShouldBindJSON(&payload); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, "hosts", payload.Hosts); err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, "snippets", payload.Snippets); err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// 비동기 작업까지는 아니지만, 클라이언트에게 "수락 후 반영" 의미를 주기 위해 202를 사용했다.
		ctx.Status(http.StatusAccepted)
	})

	return router
}

func authMiddleware(authService *auth.Service) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		// 간단한 Bearer 토큰 미들웨어로 보호된 라우트에 사용자 식별자를 주입한다.
		authorization := ctx.GetHeader("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}

		token := strings.TrimPrefix(authorization, "Bearer ")
		claims, err := authService.ParseAccessToken(token)
		if err != nil {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}

		ctx.Set("userId", claims.UserID)
		ctx.Next()
	}
}
